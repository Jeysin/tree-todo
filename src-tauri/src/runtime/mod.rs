//! 本地 MCP 服务（docs/06 v2 §4）：固定端口 + 持久 token + `POST /mcp`。
//!
//! v1 的随机端口 / run token / `/v1/runs/{id}/complete` 回执端点已随 push 方向移除：
//! Agent 侧配置里的 URL 与 token 必须跨重启稳定，端口固定（默认 39401）、token 持久化
//! 在 `app_data/mcp.json`（D28）。
//!
//! 回执鉴权 = 持久 token（Bearer）+ run_id（ULID 难猜）双因素。
//! 只绑 127.0.0.1；带 Origin 头时必须是 loopback。
//!
//! v2.1：服务改为可开关（设置页）。关闭时释放端口、停止监听；开启时重新绑定并起线程。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::agents::mcp;
use crate::error::{AppError, AppResult};

/// MCP 默认端口（docs/06 v2 §4.3；设置页可改，被占用时自动 +1 重试）。
pub const DEFAULT_MCP_PORT: u16 = 39401;

/// 关闭服务后重新打开时，为「自己刚释放的端口」预留的重绑等待上限。
/// 实测 macOS 约 30ms（等 FIN 握手收尾），留足余量以适配 CI 的慢机器。
const REBIND_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, Serialize, Deserialize)]
struct McpFile {
    port: u16,
    token: String,
    #[serde(default)]
    version: String,
}

pub struct RuntimeState {
    /// MCP 服务实际监听端口；`None` = 未运行（用户关闭或绑定失败）。
    port: Mutex<Option<u16>>,
    /// 持久 token（可重置，见 `reset_token`）。
    token: Mutex<String>,
    /// run_id → 文档库路径（回执落库用）。
    pub doc_by_run: Mutex<HashMap<String, PathBuf>>,
    /// mcp.json 路径（token 重置时回写）。
    mcp_json: PathBuf,
    /// 正在监听的 HTTP server；关闭时 unblock 并释放端口。
    server: Mutex<Option<Arc<tiny_http::Server>>>,
    /// serve 线程句柄；关闭时 join，确保端口先释放再允许重新绑定。
    thread: Mutex<Option<JoinHandle<()>>>,
    /// 上一次由本服务释放的端口。刚关闭的监听会留下正在收尾的连接，
    /// 立刻重绑可能拿到 EADDRINUSE（见 `bind_server_waiting`）。
    released_port: Mutex<Option<u16>>,
    /// 启停时 spawn 线程用。
    app: AppHandle,
}

impl RuntimeState {
    pub fn port(&self) -> Option<u16> {
        *self.port.lock().expect("port mutex poisoned")
    }

    pub fn url(&self) -> Option<String> {
        self.port().map(|p| format!("http://127.0.0.1:{p}/mcp"))
    }

    pub fn token(&self) -> String {
        self.token.lock().expect("token mutex poisoned").clone()
    }

    /// 本次运行中服务是否真正在监听（用户开关打开且绑定成功）。
    pub fn running(&self) -> bool {
        self.server
            .lock()
            .expect("server mutex poisoned")
            .is_some()
    }

    pub fn register(&self, run_id: &str, doc_path: PathBuf) {
        self.doc_by_run
            .lock()
            .expect("runtime map poisoned")
            .insert(run_id.to_string(), doc_path);
    }

    pub fn unregister(&self, run_id: &str) {
        self.doc_by_run
            .lock()
            .expect("runtime map poisoned")
            .remove(run_id);
    }

    /// 重置 token（设置页）：立即生效并持久化，旧 token 随之失效。
    pub fn reset_token(&self) -> AppResult<String> {
        let port = self.port().unwrap_or(DEFAULT_MCP_PORT);
        let token = new_token();
        let file = McpFile {
            port,
            token: token.clone(),
            version: env!("CARGO_PKG_VERSION").into(),
        };
        write_mcp_json(&self.mcp_json, &file)?;
        *self.token.lock().expect("token mutex poisoned") = token.clone();
        Ok(token)
    }

    /// 启动监听（设置页开启 / 应用启动时开关为开）。
    /// 端口被占用时从 `mcp.json` 的首选端口开始 +1 重试（最多 10 个）。
    pub fn enable(self: &Arc<Self>) -> AppResult<()> {
        let mut server_slot = self.server.lock().expect("server mutex poisoned");
        if server_slot.is_some() {
            return Ok(());
        }
        let file = read_mcp_file(&self.mcp_json)?;

        let mut bound: Option<(tiny_http::Server, u16)> = None;
        let released = *self
            .released_port
            .lock()
            .expect("released port mutex poisoned");
        for offset in 0..10u16 {
            let port = file.port.saturating_add(offset);
            if port == 0 {
                break;
            }
            // 首选端口可能是自己刚关掉的：内核还没走完上一次连接的收尾，
            // 给它一小段时间再判「被占用」；其余端口是别人的，失败就立刻试下一个。
            let server = if offset == 0 && released == Some(port) {
                bind_server_waiting(port, REBIND_TIMEOUT)
            } else {
                bind_server(port)
            };
            if let Some(server) = server {
                bound = Some((server, port));
                break;
            }
        }
        let (server, port) = match bound {
            Some(v) => v,
            None => {
                return Err(AppError::BadRequest(format!(
                    "MCP 端口 {} 起始的 10 个端口都被占用，服务未启动",
                    file.port
                )));
            }
        };
        if port != file.port {
            // 端口漂移要写回 mcp.json，并提示用户重新复制 Agent 配置。
            let updated = McpFile {
                port,
                token: file.token.clone(),
                version: file.version.clone(),
            };
            write_mcp_json(&self.mcp_json, &updated)?;
            eprintln!("MCP 端口被占用，已漂移到 {port}；请到设置页重新复制 MCP 配置");
        }

        let server = Arc::new(server);
        *self.port.lock().expect("port mutex poisoned") = Some(port);
        *self
            .released_port
            .lock()
            .expect("released port mutex poisoned") = None;
        *server_slot = Some(Arc::clone(&server));

        let st = Arc::clone(self);
        let app = self.app.clone();
        let handle = thread::spawn(move || serve(server, app, st));
        *self.thread.lock().expect("thread mutex poisoned") = Some(handle);
        Ok(())
    }

    /// 停止监听并释放端口（设置页关闭 / 应用退出时无需显式调用，进程结束即释放）。
    pub fn disable(&self) {
        let server = self.server.lock().expect("server mutex poisoned").take();
        if let Some(server) = server {
            // 唤醒阻塞在 incoming_requests() 的 serve 线程。
            server.unblock();
        }
        if let Some(handle) = self.thread.lock().expect("thread mutex poisoned").take() {
            let _ = handle.join();
        }
        let port = self.port.lock().expect("port mutex poisoned").take();
        // 记下刚释放的端口：重新打开时要对它多等一会儿（`bind_server_waiting`）。
        *self
            .released_port
            .lock()
            .expect("released port mutex poisoned") = port;
    }
}

fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// 只绑 127.0.0.1，并启用 SO_REUSEADDR。
/// 关键：MCP 开关关闭再打开时，上一次连接可能还在 TIME_WAIT（Windows 默认 2 分钟），
/// 不开 SO_REUSEADDR 会绑定失败、端口漂移，已配置的 Agent 就失联了。
fn bind_server(port: u16) -> Option<tiny_http::Server> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let socket = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::STREAM,
        Some(socket2::Protocol::TCP),
    )
    .ok()?;
    socket.set_reuse_address(true).ok()?;
    socket.bind(&addr.into()).ok()?;
    socket.listen(128).ok()?;
    let listener: std::net::TcpListener = socket.into();
    tiny_http::Server::from_listener(listener, None).ok()
}

/// 重新打开服务时给「自己刚释放的端口」用：`disable()` 只是关掉监听与连接，
/// 内核还要走完 FIN 握手。这段时间内 bind 会拿到 EADDRINUSE——
/// SO_REUSEADDR 只放过 TIME_WAIT，管不了仍在收尾的连接（macOS 实测约 30ms）。
///
/// 不重试的后果不是报错而是**端口漂移**：`enable()` 会一路试到 port+1，
/// 改掉 mcp.json 里的端口，已经配好的 Agent 就静默失联了。
fn bind_server_waiting(port: u16, timeout: Duration) -> Option<tiny_http::Server> {
    let deadline = Instant::now() + timeout;
    let mut backoff = Duration::from_millis(2);
    loop {
        if let Some(server) = bind_server(port) {
            return Some(server);
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        thread::sleep(backoff.min(deadline - now));
        backoff = (backoff * 2).min(Duration::from_millis(40));
    }
}

fn write_mcp_json(path: &PathBuf, file: &McpFile) -> AppResult<()> {
    let body = serde_json::to_vec_pretty(file)
        .map_err(|e| AppError::Io(std::io::Error::other(e)))?;
    std::fs::write(path, body)?;
    Ok(())
}

/// 读取 mcp.json；不存在时创建一份（固定端口 + 新 token）。
fn read_mcp_file(path: &PathBuf) -> AppResult<McpFile> {
    let file: McpFile = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
            AppError::Io(std::io::Error::other(format!("mcp.json 损坏: {e}")))
        })?,
        Err(_) => McpFile {
            port: DEFAULT_MCP_PORT,
            token: new_token(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
    };
    if !path.exists() {
        write_mcp_json(path, &file)?;
    }
    Ok(file)
}

/// 启动运行时：读/建 `mcp.json`（固定端口 + 持久 token）；`enabled` 为 false 时只准备配置，
/// 不监听端口（用户可在设置页随时打开）。
pub fn start(app: AppHandle, data_dir: PathBuf, enabled: bool) -> AppResult<Arc<RuntimeState>> {
    let mcp_json = data_dir.join("mcp.json");
    let file = read_mcp_file(&mcp_json)?;

    let state = Arc::new(RuntimeState {
        port: Mutex::new(None),
        token: Mutex::new(file.token),
        doc_by_run: Mutex::new(HashMap::new()),
        mcp_json,
        server: Mutex::new(None),
        thread: Mutex::new(None),
        released_port: Mutex::new(None),
        app,
    });

    if enabled && let Err(err) = state.enable() {
        // 服务起不来不阻塞应用：账本照常工作，Agent 回执进不来（设置页有告警）。
        eprintln!("MCP 服务未启动: {err}");
    }
    Ok(state)
}

fn serve(server: Arc<tiny_http::Server>, app: AppHandle, state: Arc<RuntimeState>) {
    for mut request in server.incoming_requests() {
        let method = request.method().clone();
        let url = request.url().to_string();
        let auth = header(&request, "Authorization");
        let origin = header(&request, "Origin");
        let config_agent = header(&request, "X-Tree-Todo-Agent");

        let respond = |request: tiny_http::Request, code: u16, body: &str| {
            let header =
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .expect("static header");
            let _ = request.respond(
                tiny_http::Response::from_string(body)
                    .with_status_code(code)
                    .with_header(header),
            );
        };

        if method != tiny_http::Method::Post {
            respond(request, 405, r#"{"error":"method not allowed"}"#);
            continue;
        }
        if url != "/mcp" {
            respond(request, 404, r#"{"error":"not found"}"#);
            continue;
        }
        if auth.as_deref() != Some(format!("Bearer {}", state.token()).as_str()) {
            respond(request, 401, r#"{"error":"unauthorized"}"#);
            continue;
        }
        // 带了 Origin 就必须是 loopback（浏览器环境防跨站）；不带（CLI / Agent）只靠 token。
        if let Some(o) = &origin
            && !is_loopback_origin(o)
        {
            respond(request, 403, r#"{"error":"forbidden origin"}"#);
            continue;
        }

        let mut body = String::new();
        if let Err(e) = request.as_reader().read_to_string(&mut body) {
            respond(request, 400, &format!(r#"{{"error":"bad body: {e}}}"#));
            continue;
        }

        let doc_by_run = state.doc_by_run.lock().expect("runtime map poisoned").clone();
        let ctx = mcp::McpCtx {
            doc_by_run: &doc_by_run,
            config_agent,
        };
        let app2 = app.clone();
        let response = mcp::handle(&body, &ctx, &|run_id| {
            let _ = app2.emit(
                "run:status",
                serde_json::json!({ "runId": run_id, "reason": "mcp" }),
            );
        });
        match response {
            Some(json) => respond(request, 200, &json),
            None => respond(request, 202, ""),
        }
    }
}

fn header(request: &tiny_http::Request, field: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(field))
        .map(|h| h.value.as_str().to_string())
}

fn is_loopback_origin(origin: &str) -> bool {
    let rest = origin
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    // IPv6 形如 [::1]:port，先剥方括号再取主机。
    let host = if let Some(stripped) = rest.strip_prefix('[') {
        format!("[{}]", stripped.split(']').next().unwrap_or(""))
    } else {
        rest.split(':').next().unwrap_or("").to_string()
    };
    matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]" | "::1")
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::sync::Arc;

    #[test]
    fn loopback_origin_check() {
        use super::is_loopback_origin;
        assert!(is_loopback_origin("http://127.0.0.1:1420"));
        assert!(is_loopback_origin("http://localhost:3000"));
        assert!(is_loopback_origin("http://[::1]:8080"));
        assert!(!is_loopback_origin("http://evil.example.com"));
        assert!(!is_loopback_origin("https://192.168.1.5"));
    }

    /// 开关 MCP 的前提：unblock + 释放后，同一端口在 `REBIND_TIMEOUT` 内能重新绑定。
    ///
    /// 断言不能写「立即」：关闭监听时最后一条连接的 FIN 握手还在路上，
    /// 这段时间 bind 会拿到 EADDRINUSE（macOS 实测最坏 ~32ms），
    /// 所以这里走生产同一条 `bind_server_waiting` 路径，验的是真正的保证。
    #[test]
    fn server_can_rebind_same_port_after_unblock() {
        let server = super::bind_server(0).expect("bind ephemeral port");
        let port = match server.server_addr() {
            tiny_http::ListenAddr::IP(addr) => addr.port(),
            #[cfg(unix)]
            _ => panic!("unexpected unix socket"),
        };
        let server = Arc::new(server);
        let serving = Arc::clone(&server);
        let handle = std::thread::spawn(move || {
            for request in serving.incoming_requests() {
                let _ = request.respond(tiny_http::Response::from_string("ok"));
            }
        });

        // 产生一次真实连接，尽量接近 Agent 调用后的状态（可能留下 TIME_WAIT）。
        {
            let mut client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            client
                .write_all(b"GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                .unwrap();
            let mut body = String::new();
            let _ = client.read_to_string(&mut body);
        }

        server.unblock();
        handle.join().unwrap();
        drop(server);

        let rebound = super::bind_server_waiting(port, super::REBIND_TIMEOUT);
        assert!(rebound.is_some(), "同一端口应能在关闭后重新绑定");
    }
}

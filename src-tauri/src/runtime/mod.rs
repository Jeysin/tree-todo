//! 本地 MCP 服务（docs/06 v2 §4）：固定端口 + 持久 token + `POST /mcp`。
//!
//! v1 的随机端口 / run token / `/v1/runs/{id}/complete` 回执端点已随 push 方向移除：
//! Agent 侧配置里的 URL 与 token 必须跨重启稳定，端口固定（默认 39401）、token 持久化
//! 在 `app_data/mcp.json`（D28）。
//!
//! 回执鉴权 = 持久 token（Bearer）+ run_id（ULID 难猜）双因素。
//! 只绑 127.0.0.1；带 Origin 头时必须是 loopback。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::agents::mcp;
use crate::error::{AppError, AppResult};

/// MCP 默认端口（docs/06 v2 §4.3；设置页可改，被占用时自动 +1 重试）。
pub const DEFAULT_MCP_PORT: u16 = 39401;

#[derive(Debug, Serialize, Deserialize)]
struct McpFile {
    port: u16,
    token: String,
    #[serde(default)]
    version: String,
}

pub struct RuntimeState {
    /// MCP 服务实际监听端口；`None` = 绑定失败，服务不可用（设置页显示告警）。
    pub port: Option<u16>,
    /// 持久 token（可重置，见 `reset_token`）。
    pub token: Mutex<String>,
    /// run_id → 文档库路径（回执落库用）。
    pub doc_by_run: Mutex<HashMap<String, PathBuf>>,
    /// mcp.json 路径（token 重置时回写）。
    mcp_json: PathBuf,
}

impl RuntimeState {
    pub fn url(&self) -> Option<String> {
        self.port.map(|p| format!("http://127.0.0.1:{p}/mcp"))
    }

    pub fn token(&self) -> String {
        self.token.lock().expect("token mutex poisoned").clone()
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
        let token = new_token();
        let file = McpFile {
            port: self.port.unwrap_or(DEFAULT_MCP_PORT),
            token: token.clone(),
            version: env!("CARGO_PKG_VERSION").into(),
        };
        write_mcp_json(&self.mcp_json, &file)?;
        *self.token.lock().expect("token mutex poisoned") = token.clone();
        Ok(token)
    }
}

fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn write_mcp_json(path: &PathBuf, file: &McpFile) -> AppResult<()> {
    let body = serde_json::to_vec_pretty(file)
        .map_err(|e| AppError::Io(std::io::Error::other(e)))?;
    std::fs::write(path, body)?;
    Ok(())
}

/// 启动 MCP 服务：读/建 `mcp.json`（固定端口 + 持久 token），绑定失败时逐个 +1 重试。
pub fn start(app: AppHandle, data_dir: PathBuf) -> AppResult<Arc<RuntimeState>> {
    let mcp_json = data_dir.join("mcp.json");
    let file: McpFile = match std::fs::read(&mcp_json) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
            AppError::Io(std::io::Error::other(format!("mcp.json 损坏: {e}")))
        })?,
        Err(_) => McpFile {
            port: DEFAULT_MCP_PORT,
            token: new_token(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
    };
    if !mcp_json.exists() {
        write_mcp_json(&mcp_json, &file)?;
    }

    // 绑定：首选 mcp.json 里的端口，被占用则 +1 重试（最多 10 个）。
    let mut bound: Option<(tiny_http::Server, u16)> = None;
    for offset in 0..10u16 {
        let port = file.port.saturating_add(offset);
        if port == 0 {
            break;
        }
        if let Ok(server) = tiny_http::Server::http(format!("127.0.0.1:{port}")) {
            bound = Some((server, port));
            break;
        }
    }
    let (server, port) = match bound {
        Some(v) => v,
        None => {
            // 服务起不来不阻塞应用：账本照常工作，Agent 回执进不来（设置页有告警）。
            eprintln!("MCP 端口 {} 起始的 10 个端口都被占用，MCP 服务未启动", file.port);
            let state = Arc::new(RuntimeState {
                port: None,
                token: Mutex::new(file.token),
                doc_by_run: Mutex::new(HashMap::new()),
                mcp_json,
            });
            return Ok(state);
        }
    };
    if port != file.port {
        // 端口漂移要写回 mcp.json，并提示用户重新复制 Agent 配置。
        let updated = McpFile {
            port,
            token: file.token.clone(),
            version: file.version.clone(),
        };
        write_mcp_json(&mcp_json, &updated)?;
        eprintln!("MCP 端口被占用，已漂移到 {port}；请到设置页重新复制 MCP 配置");
    }

    let state = Arc::new(RuntimeState {
        port: Some(port),
        token: Mutex::new(file.token),
        doc_by_run: Mutex::new(HashMap::new()),
        mcp_json,
    });

    let st = state.clone();
    thread::spawn(move || serve(server, app, st));
    Ok(state)
}

fn serve(server: tiny_http::Server, app: AppHandle, state: Arc<RuntimeState>) {
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
    #[test]
    fn loopback_origin_check() {
        use super::is_loopback_origin;
        assert!(is_loopback_origin("http://127.0.0.1:1420"));
        assert!(is_loopback_origin("http://localhost:3000"));
        assert!(is_loopback_origin("http://[::1]:8080"));
        assert!(!is_loopback_origin("http://evil.example.com"));
        assert!(!is_loopback_origin("https://192.168.1.5"));
    }
}

//! MCP server（docs/06 v2 §4）：Streamable HTTP、无状态、JSON-RPC 2.0。
//!
//! 工具集（阶段一）：
//! - `tree_todo_start`：Agent 开始执行 → run running、节点亮「执行中」并计时（D27）。
//! - `tree_todo_complete_tasks`：Agent 完成 → run awaiting_review / failed、停表。
//!
//! 红线（D17）：工具集里**没有**任何「验收 / 勾选」能力；所有工具都只写
//! `runs` / `run_nodes` / `exec_*`，绝不写 `nodes.status`。
//!
//! `handle` 是纯入口（给定 body + run→文档映射，返回响应 JSON），
//! HTTP 层（runtime::serve）与测试（mcp_tests）共用同一实现。

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::db::{exec, runs};
use crate::model::RunStatus;

pub const SERVER_NAME: &str = "tree-todo";
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// 一次 MCP 请求的上下文（HTTP 层从连接 / 头里提取）。
pub struct McpCtx<'a> {
    /// run_id → 文档库路径（复制时注册）。
    pub doc_by_run: &'a HashMap<String, PathBuf>,
    /// 一键复制配置时注入的 Agent 名（`X-Tree-Todo-Agent` header），D30 的优先来源。
    pub config_agent: Option<String>,
}

/// 处理一条（或一批）JSON-RPC 请求。
///
/// - 返回 `None`：notification，无需响应体。
/// - 返回 `Some(json)`：HTTP 200 的响应体。
/// - 协议级错误（无法解析 / 未知方法）以 JSON-RPC error 返回。
pub fn handle(body: &str, ctx: &McpCtx<'_>, on_status: &dyn Fn(&str)) -> Option<String> {
    let parsed: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            return Some(
                json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("parse error: {e}") }
                })
                .to_string(),
            );
        }
    };
    match parsed {
        Value::Array(list) => {
            let responses: Vec<Value> = list
                .into_iter()
                .filter_map(|req| call_one(req, ctx, on_status))
                .collect();
            if responses.is_empty() {
                None
            } else {
                Some(Value::Array(responses).to_string())
            }
        }
        req => call_one(req, ctx, on_status).map(|v| v.to_string()),
    }
}

fn call_one(req: Value, ctx: &McpCtx<'_>, on_status: &dyn Fn(&str)) -> Option<Value> {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(Value::Null);

    let result = match method {
        "initialize" => Ok(initialize(&params)),
        "notifications/initialized" | "notifications/cancelled" => return None,
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_defs() })),
        "tools/call" => tools_call(&params, ctx, on_status),
        _ => Err((-32601, format!("method not found: {method}"))),
    };

    Some(match (id, result) {
        (Some(id), Ok(result)) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        // notification 带了错误也不回应（规范：notification 无响应）。
        (None, _) => return None,
        (Some(id), Err((code, message))) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        }),
    })
}

fn initialize(params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(PROTOCOL_VERSION);
    // 客户端版本在支持列表内就原样回显，否则回落到我们实现的版本。
    let supported = [
        "2025-03-26",
        "2025-06-18",
        "2025-11-25",
        "2026-07-28",
    ];
    let version = if supported.contains(&requested) {
        requested
    } else {
        PROTOCOL_VERSION
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") }
    })
}

fn tool_defs() -> Value {
    Value::Array(vec![
        json!({
            "name": "tree_todo_start",
            "description": "标记任务开始执行。接受任务后、动手前调用：任务节点会在 tree-todo 中显示「执行中」并开始计时。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string", "description": "Prompt 中的运行 ID" },
                    "agent_name": { "type": "string", "description": "你的产品名称（如 Claude Code / Trae）" }
                },
                "required": ["run_id"]
            }
        }),
        json!({
            "name": "tree_todo_complete_tasks",
            "description": "上报任务完成情况。全部完成后调用：任务进入「待验收」，由用户验收。不要试图替用户勾选任务。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string" },
                    "tasks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string", "description": "Prompt 中给出的节点 ID" },
                                "result": { "type": "string", "enum": ["done", "skipped", "failed"] },
                                "summary": { "type": "string" }
                            },
                            "required": ["id"]
                        }
                    },
                    "summary": { "type": "string", "description": "整体总结（可选）" }
                },
                "required": ["run_id", "tasks"]
            }
        }),
    ])
}

fn tools_call(params: &Value, ctx: &McpCtx<'_>, on_status: &dyn Fn(&str)) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing tool name".into()))?;
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    match name {
        "tree_todo_start" => {
            let run_id = str_arg(&args, "run_id")
                .ok_or((-32602, "missing run_id".into()))?;
            let reported = str_arg(&args, "agent_name");
            Ok(tool_start(&run_id, reported, ctx, on_status))
        }
        "tree_todo_complete_tasks" => {
            let run_id = str_arg(&args, "run_id")
                .ok_or((-32602, "missing run_id".into()))?;
            let tasks = args.get("tasks").and_then(Value::as_array).cloned()
                .ok_or((-32602, "missing tasks".into()))?;
            let summary = str_arg(&args, "summary");
            Ok(tool_complete(&run_id, &tasks, summary, ctx, on_status))
        }
        _ => Err((-32602, format!("unknown tool: {name}"))),
    }
}

fn str_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

/// 工具结果：正常文本或业务错误（isError，不抛 JSON-RPC error）。
fn tool_text(text: &str, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error
    })
}

fn open_doc(ctx: &McpCtx<'_>, run_id: &str) -> Result<rusqlite::Connection, String> {
    let path = ctx
        .doc_by_run
        .get(run_id)
        .cloned()
        .ok_or_else(|| format!("未知运行 ID：{run_id}（tree-todo 可能已重启，请重新复制带回执的 Prompt）"))?;
    let conn = rusqlite::Connection::open(&path).map_err(|e| format!("打开文档库失败: {e}"))?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    Ok(conn)
}

/// start：dispatched → running，计时起点与 Agent 名在此落库（D27 / D30）。
fn tool_start(
    run_id: &str,
    reported_name: Option<String>,
    ctx: &McpCtx<'_>,
    on_status: &dyn Fn(&str),
) -> Value {
    let mut conn = match open_doc(ctx, run_id) {
        Ok(c) => c,
        Err(e) => return tool_text(&e, true),
    };
    let run = match runs::get_run(&conn, run_id) {
        Ok(r) => r,
        Err(_) => return tool_text(&format!("运行不存在：{run_id}"), true),
    };
    match run.status {
        RunStatus::Running => {
            // 幂等：重复 start 不覆盖首次的计时起点与 Agent 名。
            return tool_text("已在执行中（重复调用被忽略）", false);
        }
        RunStatus::AwaitingReview => {
            return tool_text("该运行已完成并等待验收，不能重新开始", true);
        }
        RunStatus::Dispatched | RunStatus::Queued => {}
        _ => {
            return tool_text(&format!("该运行已收口（{}），不能开始", run.status.as_str()), true);
        }
    }

    // Agent 名：配置注入优先，自报兜底（D30）。
    let agent_name = ctx
        .config_agent
        .clone()
        .or(reported_name)
        .unwrap_or_else(|| "unknown".into());
    let now = chrono::Utc::now().to_rfc3339();
    let apply = (|| -> crate::error::AppResult<()> {
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE runs SET status = 'running', agent_id = ?2, started_at = ?3 WHERE id = ?1",
            rusqlite::params![run_id, agent_name, now],
        )?;
        exec::sync_run(&tx, run_id)?;
        tx.commit()?;
        Ok(())
    })();
    if let Err(e) = apply {
        return tool_text(&format!("更新执行状态失败: {e}"), true);
    }
    drop(conn);
    on_status(run_id);
    tool_text(
        &format!("已标记为执行中（{agent_name}），tree-todo 开始计时。"),
        false,
    )
}

/// complete：写逐节点回执，run → awaiting_review（有 done）/ failed（全部非 done），停表。
fn tool_complete(
    run_id: &str,
    tasks: &[Value],
    summary: Option<String>,
    ctx: &McpCtx<'_>,
    on_status: &dyn Fn(&str),
) -> Value {
    if tasks.is_empty() {
        return tool_text("tasks 不能为空", true);
    }
    let mut conn = match open_doc(ctx, run_id) {
        Ok(c) => c,
        Err(e) => return tool_text(&e, true),
    };
    let run = match runs::get_run(&conn, run_id) {
        Ok(r) => r,
        Err(_) => return tool_text(&format!("运行不存在：{run_id}"), true),
    };
    if !run.status.is_active() {
        return tool_text(
            &format!("该运行已收口（{}），不再接受回执", run.status.as_str()),
            true,
        );
    }

    // 解析回执项；不属于本 run 的节点单独拒绝（§6.2）。
    let mut items: Vec<(String, String, Option<String>)> = Vec::new();
    let mut rejected: Vec<String> = Vec::new();
    for t in tasks {
        let Some(id) = t.get("id").and_then(Value::as_str) else {
            return tool_text("tasks 项缺少 id", true);
        };
        let result = t
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("done")
            .to_string();
        if !matches!(result.as_str(), "done" | "skipped" | "failed") {
            return tool_text(&format!("非法 result：{result}"), true);
        }
        let belongs: bool = conn
            .query_row(
                "SELECT 1 FROM run_nodes WHERE run_id = ?1 AND node_id = ?2",
                rusqlite::params![run_id, id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if belongs {
            items.push((
                id.to_string(),
                result,
                t.get("summary").and_then(Value::as_str).map(str::to_string),
            ));
        } else {
            rejected.push(id.to_string());
        }
    }
    if items.is_empty() {
        return tool_text(
            &format!("回执的节点都不属于本次运行：{}", rejected.join(", ")),
            true,
        );
    }

    let any_done = items.iter().any(|(_, r, _)| r == "done");
    let now = chrono::Utc::now().to_rfc3339();
    let now_ts = chrono::Utc::now().timestamp_millis();
    // 计时只在 running（有过 start）时存在；dispatched 直达 complete 则无时长。
    let duration = if run.status == RunStatus::Running {
        chrono::DateTime::parse_from_rfc3339(&run.started_at)
            .ok()
            .map(|t| (now_ts - t.timestamp_millis()).max(0))
    } else {
        None
    };

    let apply = (|| -> crate::error::AppResult<()> {
        let tx = conn.transaction()?;
        runs::update_report(&tx, run_id, &items)?;
        if let Some(s) = &summary {
            tx.execute(
                "UPDATE runs SET summary = ?2 WHERE id = ?1",
                rusqlite::params![run_id, s],
            )?;
        }
        runs::set_status(
            &tx,
            run_id,
            runs::StatusUpdate {
                status: if any_done {
                    RunStatus::AwaitingReview
                } else {
                    RunStatus::Failed
                },
                exit_code: None,
                error: None,
                needs_confirmation: false,
                finished_at: Some(&now),
                duration_ms: duration,
            },
        )?;
        exec::sync_run(&tx, run_id)?;
        tx.commit()?;
        Ok(())
    })();
    if let Err(e) = apply {
        return tool_text(&format!("记录回执失败: {e}"), true);
    }
    drop(conn);
    on_status(run_id);

    let mut text = if any_done {
        "回执已记录：任务进入「待验收」，请在 tree-todo 中验收。".to_string()
    } else {
        "回执已记录：全部节点未完成，运行标记为失败。".to_string()
    };
    if !rejected.is_empty() {
        text.push_str(&format!("\n以下节点不属于本次运行，已拒绝：{}", rejected.join(", ")));
    }
    tool_text(&text, false)
}

//! MCP 客户端模拟器（docs/06 v2 §12.1）：按真实 MCP 协议（JSON-RPC over /mcp）
//! 走完整链路，替代 v1 的假 Agent。
//!
//! 断言重点（红线）：任何调用序列后 `nodes.status` 都不变，只有验收路径能写 done。

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{json, Value};

use super::mcp::{handle, McpCtx};
use crate::db::{queries, runs, Db};
use crate::model::{ExecState, NodeStatus, RunStatus};

/// 测试夹具：临时目录里的一个真实文档库 + 一个已复制（dispatched）的 run。
struct Fixture {
    dir: PathBuf,
    db_path: PathBuf,
    node_id: String,
    run_id: String,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Windows 上 RemoveDirectory 可能因变更通知延迟报「目录不是空的」，
        // 重试清理；失败不阻塞（临时目录，系统迟早清理）。
        for _ in 0..10 {
            if std::fs::remove_dir_all(&self.dir).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}

fn setup(run_id: &str) -> Fixture {
    let dir = std::env::temp_dir().join(format!(
        "tt-mcp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("doc.db");
    let mut db = Db::open(&db_path).unwrap();
    let tx = db.conn.transaction().unwrap();
    let (root, _) = crate::propagate::create_node_at(&tx, None, "任务线", None).unwrap();
    let (child, _) =
        crate::propagate::create_node_at(&tx, Some(&root), "做一件小事", None).unwrap();
    let run = runs::new_dispatched_run(run_id, "prompt", "copy");
    runs::insert_run(&tx, &run, std::slice::from_ref(&child)).unwrap();
    tx.commit().unwrap();
    drop(db);
    Fixture {
        dir,
        db_path,
        node_id: child,
        run_id: run_id.to_string(),
    }
}

/// 在「run → 文档库」映射上执行一段 MCP 调用（`handle` 的纯入口，与 HTTP 层共用）。
fn with_ctx<T>(
    fx: &Fixture,
    config_agent: Option<&str>,
    f: impl FnOnce(&McpCtx<'_>, &dyn Fn(&str)) -> T,
) -> T {
    let mut map = HashMap::new();
    map.insert(fx.run_id.clone(), fx.db_path.clone());
    let ctx = McpCtx {
        doc_by_run: &map,
        config_agent: config_agent.map(str::to_string),
    };
    let noop = |_run_id: &str| {};
    f(&ctx, &noop)
}

fn rpc(method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string()
}

fn call_tool(name: &str, args: Value) -> String {
    rpc("tools/call", json!({ "name": name, "arguments": args }))
}

fn parse(resp: &Option<String>) -> Value {
    serde_json::from_str(resp.as_deref().expect("应有响应")).unwrap()
}

fn tool_text(v: &Value) -> String {
    v["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string()
}

fn is_tool_error(v: &Value) -> bool {
    v["result"]["isError"].as_bool().unwrap_or(false)
}

fn open_conn(fx: &Fixture) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open(&fx.db_path).unwrap();
    conn.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    conn
}

fn node_of(fx: &Fixture) -> crate::model::Node {
    let conn = open_conn(fx);
    queries::get_node(&conn, &fx.node_id).unwrap()
}

fn run_of(fx: &Fixture) -> crate::model::Run {
    let conn = open_conn(fx);
    runs::get_run(&conn, &fx.run_id).unwrap()
}

#[test]
fn initialize_and_tools_list() {
    let fx = setup("run_list");
    with_ctx(&fx, None::<&str>, |ctx, noop| {
        let init = parse(&handle(
            &rpc("initialize", json!({ "protocolVersion": "2025-06-18" })),
            ctx,
            noop,
        ));
        assert_eq!(init["result"]["serverInfo"]["name"], "tree-todo");
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");

        let list = parse(&handle(&rpc("tools/list", json!({})), ctx, noop));
        let names: Vec<&str> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["tree_todo_start", "tree_todo_complete_tasks"]);
        // 红线（D17）：工具集里不得有验收 / 勾选类工具。
        for n in &names {
            assert!(!n.contains("accept"), "不得有验收工具: {n}");
            assert!(!n.contains("review"), "不得有验收工具: {n}");
            assert!(!n.contains("check"), "不得有勾选工具: {n}");
        }
    });
}

#[test]
fn two_phase_receipt_full_flow() {
    let fx = setup("run_full");

    // 阶段一：start → running + Agent 名（配置注入优先，D30）+ 计时起点。
    let start = with_ctx(&fx, Some("Trae"), |ctx, noop| {
        parse(&handle(
            &call_tool(
                "tree_todo_start",
                json!({ "run_id": fx.run_id, "agent_name": "自报名" }),
            ),
            ctx,
            noop,
        ))
    });
    assert!(!is_tool_error(&start), "{}", tool_text(&start));
    let node = node_of(&fx);
    assert_eq!(node.status, NodeStatus::Pending, "红线：start 不得写主状态");
    let exec = node.execution.expect("start 后节点应有执行态");
    assert_eq!(exec.state, ExecState::Running);
    assert_eq!(exec.agent_name, "Trae", "配置注入优先于自报");
    assert!(!run_of(&fx).started_at.is_empty(), "start 刷新计时起点");

    // 阶段二：complete(done) → awaiting_review + 停表。
    let complete = with_ctx(&fx, Some("Trae"), |ctx, noop| {
        parse(&handle(
            &call_tool(
                "tree_todo_complete_tasks",
                json!({ "run_id": fx.run_id, "tasks": [
                    { "id": fx.node_id, "result": "done", "summary": "改了 3 个文件" }
                ]}),
            ),
            ctx,
            noop,
        ))
    });
    assert!(!is_tool_error(&complete), "{}", tool_text(&complete));
    let node = node_of(&fx);
    assert_eq!(node.status, NodeStatus::Pending, "红线：complete 不得写主状态");
    let exec = node.execution.expect("complete 后节点应为待验收");
    assert_eq!(exec.state, ExecState::AwaitingReview);
    assert!(exec.duration_ms.is_some(), "running→complete 应记录时长");
    assert_eq!(run_of(&fx).status, RunStatus::AwaitingReview);

    // 待验收期间允许补充回执（docs/06 v2 §6.2：用户还没验收，允许修正）。
    let amend = with_ctx(&fx, Some("Trae"), |ctx, noop| {
        parse(&handle(
            &call_tool(
                "tree_todo_complete_tasks",
                json!({ "run_id": fx.run_id, "tasks": [
                    { "id": fx.node_id, "result": "done", "summary": "修正后的说明" }
                ]}),
            ),
            ctx,
            noop,
        ))
    });
    assert!(!is_tool_error(&amend), "{}", tool_text(&amend));

    // 收口后（模拟验收）再 complete 才被拒。
    {
        let mut conn = open_conn(&fx);
        let tx = conn.transaction().unwrap();
        runs::set_review(&tx, &fx.run_id, std::slice::from_ref(&fx.node_id), "accepted").unwrap();
        runs::maybe_mark_reviewed(&tx, &fx.run_id).unwrap();
        tx.commit().unwrap();
    }
    let again = with_ctx(&fx, Some("Trae"), |ctx, noop| {
        parse(&handle(
            &call_tool(
                "tree_todo_complete_tasks",
                json!({ "run_id": fx.run_id, "tasks": [{ "id": fx.node_id, "result": "done" }] }),
            ),
            ctx,
            noop,
        ))
    });
    assert!(is_tool_error(&again), "已收口的 run 不得再收回执");
}

#[test]
fn duplicate_start_is_idempotent_and_keeps_first_agent() {
    let fx = setup("run_dup");
    for config in [Some("Trae"), Some("Claude Code")] {
        let resp = with_ctx(&fx, config, |ctx, noop| {
            parse(&handle(
                &call_tool("tree_todo_start", json!({ "run_id": fx.run_id })),
                ctx,
                noop,
            ))
        });
        assert!(!is_tool_error(&resp));
    }
    assert_eq!(
        node_of(&fx).execution.unwrap().agent_name,
        "Trae",
        "重复 start 不覆盖首次 Agent 名"
    );
}

#[test]
fn complete_without_start_accepted_without_duration() {
    let fx = setup("run_nostart");
    let resp = with_ctx(&fx, None::<&str>, |ctx, noop| {
        parse(&handle(
            &call_tool(
                "tree_todo_complete_tasks",
                json!({ "run_id": fx.run_id, "tasks": [{ "id": fx.node_id, "result": "done" }] }),
            ),
            ctx,
            noop,
        ))
    });
    assert!(!is_tool_error(&resp), "{}", tool_text(&resp));
    let node = node_of(&fx);
    assert_eq!(node.status, NodeStatus::Pending);
    let exec = node.execution.unwrap();
    assert_eq!(exec.state, ExecState::AwaitingReview);
    assert!(exec.duration_ms.is_none(), "没 start 直达 complete 无时长");
}

#[test]
fn all_non_done_results_mark_run_failed() {
    let fx = setup("run_skip");
    let resp = with_ctx(&fx, None::<&str>, |ctx, noop| {
        parse(&handle(
            &call_tool(
                "tree_todo_complete_tasks",
                json!({ "run_id": fx.run_id, "tasks": [
                    { "id": fx.node_id, "result": "skipped", "summary": "依赖未就绪" }
                ]}),
            ),
            ctx,
            noop,
        ))
    });
    assert!(!is_tool_error(&resp));
    let node = node_of(&fx);
    assert_eq!(node.status, NodeStatus::Pending);
    assert_eq!(
        node.execution.unwrap().state,
        ExecState::Failed,
        "全部非 done → failed 投影"
    );
    assert_eq!(run_of(&fx).status, RunStatus::Failed);
}

#[test]
fn foreign_node_rejected() {
    let fx = setup("run_foreign");
    let resp = with_ctx(&fx, None::<&str>, |ctx, noop| {
        parse(&handle(
            &call_tool(
                "tree_todo_complete_tasks",
                json!({ "run_id": fx.run_id, "tasks": [{ "id": "not-in-run", "result": "done" }] }),
            ),
            ctx,
            noop,
        ))
    });
    assert!(is_tool_error(&resp), "不属于该 run 的节点要被拒绝");
}

#[test]
fn unknown_run_and_protocol_errors() {
    let fx = setup("run_unknown");
    let resp = with_ctx(&fx, None::<&str>, |ctx, noop| {
        parse(&handle(
            &call_tool("tree_todo_start", json!({ "run_id": "run_nope" })),
            ctx,
            noop,
        ))
    });
    assert!(is_tool_error(&resp));

    // 协议级：未知方法 → JSON-RPC error。
    let bad = with_ctx(&fx, None::<&str>, |ctx, noop| {
        parse(&handle(&rpc("resources/list", json!({})), ctx, noop))
    });
    assert_eq!(bad["error"]["code"].as_i64(), Some(-32601));

    // 解析失败 → -32700。
    let broken =
        with_ctx(&fx, None::<&str>, |ctx, noop| parse(&handle("{not json", ctx, noop)));
    assert_eq!(broken["error"]["code"].as_i64(), Some(-32700));
}

#[test]
fn red_line_never_writes_node_status() {
    // 穷举工具调用组合后节点主状态不变（DoD-2 红线断言）。
    let combos: Vec<Vec<(&str, Value)>> = vec![
        vec![("tree_todo_start", json!({ "run_id": "run_rl" }))],
        vec![
            ("tree_todo_start", json!({ "run_id": "run_rl" })),
            (
                "tree_todo_complete_tasks",
                json!({ "run_id": "run_rl", "tasks": [
                    { "id": "PLACEHOLDER", "result": "done" }
                ]}),
            ),
        ],
        vec![
            ("tree_todo_start", json!({ "run_id": "run_rl" })),
            ("tree_todo_start", json!({ "run_id": "run_rl" })),
            (
                "tree_todo_complete_tasks",
                json!({ "run_id": "run_rl", "tasks": [
                    { "id": "PLACEHOLDER", "result": "failed" }
                ]}),
            ),
        ],
    ];
    for combo in combos {
        let fx = setup("run_rl");
        for (tool, mut args) in combo {
            if let Some(tasks) = args.get_mut("tasks").and_then(Value::as_array_mut) {
                for t in tasks.iter_mut() {
                    t["id"] = json!(fx.node_id);
                }
            }
            let resp = with_ctx(&fx, None::<&str>, |ctx, noop| {
                parse(&handle(&call_tool(tool, args.clone()), ctx, noop))
            });
            assert!(!is_tool_error(&resp), "{}", tool_text(&resp));
            assert_eq!(
                node_of(&fx).status,
                NodeStatus::Pending,
                "红线：{tool} 之后主状态必须仍是 pending"
            );
        }
    }
}

//! 复制 Prompt / MCP 配置 / 验收 / 运行查询（docs/06 v2 §11.1）。
//!
//! push 方向的派发命令（dispatch_run / cancel_run / 派发配置系列）已随 v2 移除；
//! 回执只经 MCP server（agents::mcp）进入，命令层不再有 spawn 逻辑。

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::agents::{self, PromptVariant};
use crate::db::{exec, queries, runs};
use crate::error::{AppError, AppResult};
use crate::history;
use crate::model::{Affected, Node, RunView};
use crate::AppState;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn children_map(all: &[Node]) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for n in all {
        if let Some(p) = &n.parent_id {
            map.entry(p.clone()).or_default().push(n.id.clone());
        }
    }
    for v in map.values_mut() {
        v.sort_by(|a, b| {
            let pa = all.iter().find(|n| &n.id == a).map(|n| n.position).unwrap_or(0.0);
            let pb = all.iter().find(|n| &n.id == b).map(|n| n.position).unwrap_or(0.0);
            pa.partial_cmp(&pb).unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    map
}

/// 组装 Prompt 的公共输入：选中节点 + 全节点映射 + 子节点映射 + 文档名。
struct PromptInputs {
    selected: Vec<Node>,
    all: HashMap<String, Node>,
    children: HashMap<String, Vec<String>>,
    doc_name: String,
}

/// 组装 Prompt 的公共部分：选中节点 + 文档名。
fn prompt_inputs(state: &State<'_, AppState>, node_ids: &[String]) -> AppResult<PromptInputs> {
    let doc = state.current.lock().expect("current doc mutex poisoned");
    let all_nodes = queries::all_nodes(&doc.db.conn)?;
    let map: HashMap<String, Node> = all_nodes.iter().cloned().map(|n| (n.id.clone(), n)).collect();
    let selected: Vec<Node> = node_ids.iter().filter_map(|id| map.get(id).cloned()).collect();
    if selected.is_empty() {
        return Err(AppError::BadRequest("没有可复制的节点".into()));
    }
    let children = children_map(&all_nodes);
    let idx = state.docs.load_index().ok();
    let doc_name = idx
        .as_ref()
        .and_then(|i| i.documents.iter().find(|d| d.id == doc.id))
        .map(|d| d.name.clone())
        .unwrap_or_else(|| "未命名文档".into());
    Ok(PromptInputs { selected, all: map, children, doc_name })
}

/// 「复制 Prompt」的结果：带回执变体携带 run_id（前端 toast 与测试定位用）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub prompt: String,
    pub run_id: Option<String>,
    /// true = 复用了尚未 start 的 dispatched run（D31 幂等）。
    pub reused: bool,
}

/// 复制 Prompt（docs/06 v2 §5.1 两个变体）。
///
/// - `plain`：纯文本，不建 run、不碰任何状态。
/// - `receipt`：建/复用 dispatched run（节点无投影，D29），Prompt 带完成协议。
#[tauri::command]
pub fn copy_prompt(
    app: AppHandle,
    state: State<'_, AppState>,
    node_ids: Vec<String>,
    variant: String,
) -> AppResult<CopyResult> {
    let variant = PromptVariant::parse(&variant)
        .ok_or_else(|| AppError::BadRequest(format!("未知变体: {variant}")))?;
    let mut ids: Vec<String> = node_ids.into_iter().collect();
    ids.sort();
    ids.dedup();

    if variant == PromptVariant::Plain {
        let inputs = prompt_inputs(&state, &ids)?;
        let prompt = agents::build_prompt(&agents::PromptOptions {
            doc_name: &inputs.doc_name,
            nodes: &inputs.selected,
            all_nodes: &inputs.all,
            children_of: &inputs.children,
            run_id: None,
            variant,
        });
        return Ok(CopyResult { prompt, run_id: None, reused: false });
    }

    // ── 带回执：幂等复用 / supersede / 新建（D31）──
    let inputs = prompt_inputs(&state, &ids)?;
    let mut doc = state.current.lock().expect("current doc mutex poisoned");

    let reuse = runs::find_dispatched_by_nodes(&doc.db.conn, &ids)?;
    if reuse.is_none() {
        // 挂着的 running / awaiting_review 先收口 superseded。
        let tx = doc.db.conn.transaction()?;
        runs::supersede_active_runs(&tx, &ids, None)?;
        tx.commit()?;
    }
    let run_id = reuse
        .clone()
        .unwrap_or_else(|| format!("run_{}", uuid::Uuid::new_v4().simple()));

    let mode = if ids.len() > 1 { "copy-multi" } else { "copy" };
    let prompt = agents::build_prompt(&agents::PromptOptions {
        doc_name: &inputs.doc_name,
        nodes: &inputs.selected,
        all_nodes: &inputs.all,
        children_of: &inputs.children,
        run_id: Some(&run_id),
        variant,
    });

    let db_path = state.docs.db_path(&doc.id);
    match &reuse {
        Some(_) => {
            // 复用：刷新 prompt 快照与时间戳，账本不增行。
            let tx = doc.db.conn.transaction()?;
            tx.execute(
                "UPDATE runs SET prompt = ?2, started_at = ?3 WHERE id = ?1",
                rusqlite::params![run_id, prompt, now()],
            )?;
            tx.commit()?;
        }
        None => {
            let run = runs::new_dispatched_run(&run_id, &prompt, mode);
            let tx = doc.db.conn.transaction()?;
            runs::insert_run(&tx, &run, &ids)?;
            tx.commit()?;
        }
    }
    drop(doc);

    state.runtime.register(&run_id, db_path);
    let _ = app.emit(
        "run:status",
        serde_json::json!({ "runId": run_id, "reason": "copied" }),
    );
    Ok(CopyResult {
        prompt,
        run_id: Some(run_id),
        reused: reuse.is_some(),
    })
}

/// 预览 Prompt（无副作用：不建 run、不写库）。
#[tauri::command]
pub fn preview_prompt(
    state: State<'_, AppState>,
    node_ids: Vec<String>,
    variant: String,
) -> AppResult<String> {
    let variant = PromptVariant::parse(&variant)
        .ok_or_else(|| AppError::BadRequest(format!("未知变体: {variant}")))?;
    let inputs = prompt_inputs(&state, &node_ids)?;
    Ok(agents::build_prompt(&agents::PromptOptions {
        doc_name: &inputs.doc_name,
        nodes: &inputs.selected,
        all_nodes: &inputs.all,
        children_of: &inputs.children,
        run_id: None,
        variant,
    }))
}

#[tauri::command]
pub fn list_runs(state: State<'_, AppState>) -> AppResult<Vec<RunView>> {
    let doc = state.current.lock().expect("current doc mutex poisoned");
    let list = runs::list_runs(&doc.db.conn, 100)?;
    let mut out = Vec::with_capacity(list.len());
    for run in list {
        let nodes = runs::run_nodes(&doc.db.conn, &run.id)?;
        out.push(RunView { run, nodes });
    }
    Ok(out)
}

#[tauri::command]
pub fn get_run(state: State<'_, AppState>, run_id: String) -> AppResult<RunView> {
    let doc = state.current.lock().expect("current doc mutex poisoned");
    runs::get_run_view(&doc.db.conn, &run_id)
}

/// running 卡死时的手动收口（docs/06 v2 §6.2「标记结束」，D33）。
#[tauri::command]
pub fn close_run(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    reason: Option<String>,
) -> AppResult<()> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let run = runs::get_run(&tx, &run_id)?;
    if !run.status.is_active() {
        return Err(AppError::BadRequest(format!(
            "该运行已收口（{}），无需结束",
            run.status.as_str()
        )));
    }
    let summary = reason.unwrap_or_else(|| "manual-close".into());
    let now_ts = chrono::Utc::now().timestamp_millis();
    let duration = chrono::DateTime::parse_from_rfc3339(&run.started_at)
        .ok()
        .map(|t| (now_ts - t.timestamp_millis()).max(0));
    runs::set_status(
        &tx,
        &run_id,
        runs::StatusUpdate {
            status: crate::model::RunStatus::Cancelled,
            exit_code: None,
            error: None,
            needs_confirmation: false,
            finished_at: Some(&now()),
            duration_ms: duration,
        },
    )?;
    tx.execute(
        "UPDATE runs SET summary = ?2 WHERE id = ?1",
        rusqlite::params![run_id, summary],
    )?;
    exec::sync_run(&tx, &run_id)?;
    tx.commit()?;
    drop(doc);
    state.runtime.unregister(&run_id);
    let _ = app.emit(
        "run:status",
        serde_json::json!({ "runId": run_id, "reason": "closed" }),
    );
    Ok(())
}

fn before_of(conn: &rusqlite::Connection, ids: &[String]) -> AppResult<Vec<Node>> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        for n in queries::subtree_nodes(conn, id)? {
            if seen.insert(n.id.clone()) {
                out.push(n);
            }
        }
        if let Ok(node) = queries::get_node(conn, id) {
            for n in queries::ancestors(conn, node.parent_id.as_deref())? {
                if seen.insert(n.id.clone()) {
                    out.push(n);
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn accept_run(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    node_ids: Vec<String>,
) -> AppResult<Affected> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let before = before_of(&doc.db.conn, &node_ids)?;
    let tx = doc.db.conn.transaction()?;
    let mut history = state.history.lock().expect("history mutex poisoned");
    let affected = history::run_with_history(&tx, before, &mut history, |tx| {
        runs::set_review(tx, &run_id, &node_ids, "accepted")?;
        let mut upserted: HashMap<String, Node> = HashMap::new();
        for id in &node_ids {
            exec::clear_node(tx, id)?;
            if let Ok(node) = queries::get_node(tx, id)
                && node.status != crate::model::NodeStatus::Done {
                    for n in crate::propagate::complete(tx, id)? {
                        upserted.insert(n.id.clone(), n);
                    }
                }
        }
        runs::maybe_mark_reviewed(tx, &run_id)?;
        exec::sync_run(tx, &run_id)?;
        Ok(Affected {
            upserted: upserted.into_values().collect(),
            removed: Vec::new(),
        })
    })?;
    tx.commit()?;
    drop(doc);
    let _ = app.emit("run:status", serde_json::json!({ "runId": run_id, "reason": "accepted" }));
    Ok(affected)
}

#[tauri::command]
pub fn reject_run(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    node_ids: Vec<String>,
    feedback: String,
) -> AppResult<()> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    runs::set_review(&tx, &run_id, &node_ids, "rejected")?;
    for id in &node_ids {
        exec::clear_node(&tx, id)?;
        if !feedback.trim().is_empty()
            && let Ok(node) = queries::get_node(&tx, id) {
                let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M");
                let note = if node.note.trim().is_empty() {
                    format!("## 执行反馈（{stamp}）\n{}", feedback.trim())
                } else {
                    format!("{}\n\n## 执行反馈（{stamp}）\n{}", node.note, feedback.trim())
                };
                queries::update_note(&tx, id, &note, &now())?;
            }
    }
    runs::maybe_mark_reviewed(&tx, &run_id)?;
    exec::sync_run(&tx, &run_id)?;
    tx.commit()?;
    drop(doc);
    let _ = app.emit("run:status", serde_json::json!({ "runId": run_id, "reason": "rejected" }));
    Ok(())
}

#[tauri::command]
pub fn accept_node(
    app: AppHandle,
    state: State<'_, AppState>,
    node_id: String,
) -> AppResult<Affected> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let node = queries::get_node(&doc.db.conn, &node_id)?;
    let mut before = vec![node.clone()];
    before.extend(queries::ancestors(&doc.db.conn, node.parent_id.as_deref())?);
    let tx = doc.db.conn.transaction()?;
    let mut history = state.history.lock().expect("history mutex poisoned");
    let affected = history::run_with_history(&tx, before, &mut history, |tx| {
        exec::clear_node(tx, &node_id)?;
        let upserted = if node.status == crate::model::NodeStatus::Done {
            vec![queries::get_node(tx, &node_id)?]
        } else {
            crate::propagate::complete(tx, &node_id)?
        };
        Ok(Affected { upserted, removed: Vec::new() })
    })?;
    tx.commit()?;
    let _ = app.emit("run:status", serde_json::json!({ "runId": "", "reason": "accepted-node" }));
    Ok(affected)
}

#[tauri::command]
pub fn dismiss_node(state: State<'_, AppState>, node_id: String) -> AppResult<Affected> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    exec::clear_node(&tx, &node_id)?;
    // 忽略 = 这条执行记录就此收口：run_nodes 置 dismissed，
    // 若其所在 run 已无待验收节点 → run 收口 reviewed。
    // 否则 run 永远卡在 awaiting_review，节点也无法再次派发。
    let ts = now();
    tx.execute(
        "UPDATE run_nodes SET review = 'dismissed', reviewed_at = ?2
         WHERE node_id = ?1 AND review = 'pending'",
        rusqlite::params![node_id, ts],
    )?;
    let affected_runs: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT run_id FROM run_nodes WHERE node_id = ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![node_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for rid in &affected_runs {
        tx.execute(
            "UPDATE runs SET status = 'reviewed', reviewed_at = COALESCE(reviewed_at, ?2)
             WHERE id = ?1 AND status = 'awaiting_review'
               AND NOT EXISTS (SELECT 1 FROM run_nodes WHERE run_id = runs.id AND review = 'pending')",
            rusqlite::params![rid, ts],
        )?;
        runs::maybe_mark_reviewed(&tx, rid)?;
        exec::sync_run(&tx, rid)?;
    }
    let node = queries::get_node(&tx, &node_id)?;
    tx.commit()?;
    Ok(Affected { upserted: vec![node], removed: Vec::new() })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecCounts {
    pub running: i64,
    pub awaiting: i64,
    pub failed: i64,
}

#[tauri::command]
pub fn exec_counts(state: State<'_, AppState>) -> AppResult<ExecCounts> {
    let doc = state.current.lock().expect("current doc mutex poisoned");
    let (running, awaiting, failed) = exec::counts(&doc.db.conn)?;
    Ok(ExecCounts { running, awaiting, failed })
}

/// 待验收的运行（顶部徽标 / 平铺视图筛选）。
#[tauri::command]
pub fn list_pending_reviews(state: State<'_, AppState>) -> AppResult<Vec<RunView>> {
    let doc = state.current.lock().expect("current doc mutex poisoned");
    let mut out = Vec::new();
    for run in runs::active_runs(&doc.db.conn)? {
        if run.status != crate::model::RunStatus::AwaitingReview {
            continue;
        }
        let nodes = runs::run_nodes(&doc.db.conn, &run.id)?;
        out.push(RunView { run, nodes });
    }
    Ok(out)
}

/// 清理已收口的运行记录。`before_days = 0` 表示全清。
#[tauri::command]
pub fn purge_runs(state: State<'_, AppState>, before_days: i64) -> AppResult<u64> {
    let doc = state.current.lock().expect("current doc mutex poisoned");
    let n = if before_days <= 0 {
        runs::purge_all_closed(&doc.db.conn)?
    } else {
        runs::purge_old(&doc.db.conn, before_days)?
    };
    Ok(n)
}

#[tauri::command]
pub fn open_path(path: String) -> AppResult<()> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&path).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(&path).spawn()?;
    }
    Ok(())
}

/// 写系统剪贴板。
///
/// 为什么不走前端 `navigator.clipboard`：WebView2 里它依赖 secure context 与权限，
/// 实测会静默失败（用户点「复制 Prompt」剪贴板是空的）。统一走原生实现，前端仅兜底。
#[tauri::command]
pub fn copy_text(text: String) -> AppResult<()> {
    if text.is_empty() {
        return Err(AppError::BadRequest("没有可复制的内容".into()));
    }
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| AppError::BadRequest(format!("写入剪贴板失败: {e}")))?;
    Ok(())
}

// ── MCP 集成（设置页，docs/06 v2 §4.4 / §9.3）──

/// MCP 配置视图。token 明文返回：设置页要把它复制进 Agent 配置。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigView {
    pub enabled: bool,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub token: String,
}

#[tauri::command]
pub fn get_mcp_config(state: State<'_, AppState>) -> McpConfigView {
    McpConfigView {
        enabled: state.runtime.port.is_some(),
        port: state.runtime.port,
        url: state.runtime.url(),
        token: state.runtime.token(),
    }
}

#[tauri::command]
pub fn reset_mcp_token(state: State<'_, AppState>) -> AppResult<McpConfigView> {
    state.runtime.reset_token()?;
    Ok(get_mcp_config(state))
}

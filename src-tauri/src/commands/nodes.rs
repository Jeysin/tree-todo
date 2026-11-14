//! IPC 命令层（AGENTS.md：薄层——参数校验、事务编排与历史记录；领域逻辑全部在 propagate.rs）。
//! 约定（docs/01 D6）：变更类 command 返回「受影响快照」，前端以返回结果为准受控刷新。
//! 撤销（docs/05 M2）：除视图类（set_collapsed / expand_nodes / collapse_all）外，
//! 所有变更均记录 history entry（before 快照 + after 变更）。
//! v0.3：数据源为「当前文档」（state.current），切换文档不影响其他文档。

use std::collections::HashSet;

use tauri::{AppHandle, Emitter, State};

use crate::clipboard::{self, ClipboardInfo};
use crate::db::{exec, queries, runs};
use crate::error::{AppError, AppResult};
use crate::history;
use crate::model::{Affected, CreateResult, ExecState, Node, NodeStatus, PasteResult};
use crate::propagate;
use crate::AppState;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 全量树：启动 / 切换文档时加载一次，此后靠变更快照增量合并。
#[tauri::command]
pub fn get_tree(state: State<'_, AppState>) -> AppResult<Vec<Node>> {
    let doc = state.current.lock().expect("current doc mutex poisoned");
    queries::all_nodes(&doc.db.conn)
}

/// 创建节点（C1）：父节点为 None 时创建根；`position` 用于“插入为兄弟”保持顺序。
#[tauri::command]
pub fn create_node(
    state: State<'_, AppState>,
    parent_id: Option<String>,
    content: String,
    position: Option<f64>,
) -> AppResult<CreateResult> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    if let Some(pid) = parent_id.as_deref() {
        let _ = queries::get_node(&tx, pid)?; // 父不存在 → NodeNotFound
    } else if queries::root_id(&tx)?.is_some() {
        // 单根模型：根由数据库保证存在，业务层不再创建第二个根。
        return Err(crate::error::AppError::RootProtected);
    }
    let before = queries::ancestors(&tx, parent_id.as_deref())?;
    let mut new_id = String::new();
    let mut history = state.history.lock().expect("history mutex poisoned");
    let affected = history::run_with_history(&tx, before, &mut history, |tx| {
        let (id, mut upserted) =
            propagate::create_node_at(tx, parent_id.as_deref(), &content, position)?;
        new_id = id.clone();
        upserted.push(queries::get_node(tx, &id)?);
        Ok(Affected {
            upserted,
            removed: Vec::new(),
        })
    })?;
    tx.commit()?;
    Ok(CreateResult {
        new_id,
        upserted: affected.upserted,
    })
}

/// 编辑内容（E1）：不触发任何状态变化。
#[tauri::command]
pub fn update_content(
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> AppResult<Affected> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let before = vec![queries::get_node(&tx, &id)?];
    let mut history = state.history.lock().expect("history mutex poisoned");
    let affected = history::run_with_history(&tx, before, &mut history, |tx| {
        queries::update_content(tx, &id, &content, &now())?;
        Ok(Affected {
            upserted: vec![queries::get_node(tx, &id)?],
            removed: Vec::new(),
        })
    })?;
    tx.commit()?;
    Ok(affected)
}

/// 编辑备注（E1：不触发状态变化）。
#[tauri::command]
pub fn update_note(state: State<'_, AppState>, id: String, note: String) -> AppResult<Affected> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let before = vec![queries::get_node(&tx, &id)?];
    let mut history = state.history.lock().expect("history mutex poisoned");
    let affected = history::run_with_history(&tx, before, &mut history, |tx| {
        queries::update_note(tx, &id, &note, &now())?;
        Ok(Affected {
            upserted: vec![queries::get_node(tx, &id)?],
            removed: Vec::new(),
        })
    })?;
    tx.commit()?;
    Ok(affected)
}

/// 切换状态：pending → complete（M1/M2 级联）；done → uncomplete（M3 级联）。
#[tauri::command]
pub fn toggle_status(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Affected> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let node = queries::get_node(&tx, &id)?;
    let mut before = queries::subtree_nodes(&tx, &id)?;
    before.extend(queries::ancestors(&tx, node.parent_id.as_deref())?);
    let mut history = state.history.lock().expect("history mutex poisoned");
    // 本次操作隐式验收过的 run：提交后要通知前端刷新运行账本。
    let mut touched_runs: HashSet<String> = HashSet::new();
    let affected = history::run_with_history(&tx, before, &mut history, |tx| {
        // 手动勾选待验收节点 = 隐式验收；顺手清掉执行态，避免徽标残留。
        if let Some(rid) = node.execution.as_ref().and_then(|e| e.run_id.clone()) {
            runs::set_review(tx, &rid, std::slice::from_ref(&id), "accepted")?;
            touched_runs.insert(rid);
        }
        exec::clear_node(tx, &id)?;
        let mut upserted = match node.status {
            NodeStatus::Pending => propagate::complete(tx, &id)?,
            NodeStatus::Done => propagate::uncomplete(tx, &id)?,
        };
        // 勾选会把整棵子树置 done：后代里仍在「待验收」的节点同样视为隐式验收。
        // 不处理的话，它们会以 done 状态继续挂在运行抽屉的待验收列表里（状态机分叉）。
        let mut cleared: Vec<String> = Vec::new();
        for n in upserted.iter_mut() {
            if n.status != NodeStatus::Done {
                continue;
            }
            let (exec_state, run_id) = match n.execution.as_ref() {
                Some(e) => (e.state, e.run_id.clone()),
                None => continue,
            };
            if exec_state != ExecState::AwaitingReview {
                continue;
            }
            if let Some(rid) = run_id {
                runs::set_review(tx, &rid, std::slice::from_ref(&n.id), "accepted")?;
                touched_runs.insert(rid);
            }
            exec::clear_node(tx, &n.id)?;
            cleared.push(n.id.clone());
        }
        for rid in &touched_runs {
            runs::maybe_mark_reviewed(tx, rid)?;
            exec::sync_run(tx, rid)?;
        }
        // 执行态是在快照之后清掉的：把这些节点重新读一遍，前端才能看到徽标消失。
        for nid in cleared {
            if let Some(slot) = upserted.iter_mut().find(|n| n.id == nid) {
                *slot = queries::get_node(tx, &nid)?;
            }
        }
        Ok(Affected {
            upserted,
            removed: Vec::new(),
        })
    })?;
    tx.commit()?;
    drop(doc);
    if !touched_runs.is_empty() {
        let run_id = touched_runs.iter().next().cloned().unwrap_or_default();
        let _ = app.emit(
            "run:status",
            serde_json::json!({ "runId": run_id, "reason": "accepted-node" }),
        );
    }
    Ok(affected)
}

/// 删除节点（D1）：物理删除整棵子树；根任务不可删除。
#[tauri::command]
pub fn delete_node(state: State<'_, AppState>, id: String) -> AppResult<Affected> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let node = queries::get_node(&tx, &id)?;
    if node.parent_id.is_none() {
        return Err(crate::error::AppError::RootProtected);
    }
    let mut before = queries::subtree_nodes(&tx, &id)?;
    before.extend(queries::ancestors(&tx, node.parent_id.as_deref())?);
    let mut history = state.history.lock().expect("history mutex poisoned");
    let affected = history::run_with_history(&tx, before, &mut history, |tx| {
        // 节点物理删除前，把它名下的待验收记录收口，避免 run 永远卡在 awaiting_review。
        let ids = queries::subtree_ids(tx, &id)?;
        let ts = now();
        for nid in &ids {
            tx.execute(
                "UPDATE run_nodes SET review = 'rejected', reviewed_at = ?2
                 WHERE node_id = ?1 AND review = 'pending'",
                rusqlite::params![nid, ts],
            )?;
        }
        tx.execute(
            "UPDATE runs SET status = 'reviewed', reviewed_at = ?1
             WHERE status = 'awaiting_review'
               AND NOT EXISTS (SELECT 1 FROM run_nodes WHERE run_id = runs.id AND review = 'pending')",
            rusqlite::params![ts],
        )?;
        let (removed, upserted) = propagate::delete_node(tx, &id)?;
        Ok(Affected { upserted, removed })
    })?;
    tx.commit()?;
    Ok(affected)
}

/// 移动节点（MV1）：拖拽移动 / Alt 排序；防环（CC8），新旧两路传播。
#[tauri::command]
pub fn move_node(
    state: State<'_, AppState>,
    id: String,
    new_parent_id: Option<String>,
    position: Option<f64>,
) -> AppResult<Affected> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let node = queries::get_node(&tx, &id)?;
    if node.parent_id.is_none() || new_parent_id.is_none() {
        return Err(crate::error::AppError::RootProtected);
    }
    let mut before = vec![node.clone()];
    let mut seen: std::collections::HashSet<String> = before.iter().map(|n| n.id.clone()).collect();
    for chain in [
        queries::ancestors(&tx, node.parent_id.as_deref())?,
        queries::ancestors(&tx, new_parent_id.as_deref())?,
    ] {
        for n in chain {
            if seen.insert(n.id.clone()) {
                before.push(n);
            }
        }
    }
    let mut history = state.history.lock().expect("history mutex poisoned");
    let affected = history::run_with_history(&tx, before, &mut history, |tx| {
        let upserted = propagate::move_node(tx, &id, new_parent_id.as_deref(), position)?;
        Ok(Affected {
            upserted,
            removed: Vec::new(),
        })
    })?;
    tx.commit()?;
    Ok(affected)
}

/// 折叠/展开（视图状态持久化，不计入撤销历史）。
#[tauri::command]
pub fn set_collapsed(
    state: State<'_, AppState>,
    id: String,
    collapsed: bool,
) -> AppResult<Affected> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let current = queries::get_node(&tx, &id)?;
    // 根任务在 Mind Elixir 中始终展开，不持久化根折叠。
    if !(current.parent_id.is_none() && collapsed) {
        queries::set_collapsed(&tx, &id, collapsed, &now())?;
    }
    let node = queries::get_node(&tx, &id)?;
    tx.commit()?;
    Ok(Affected {
        upserted: vec![node],
        removed: Vec::new(),
    })
}

/// 批量展开（跳转定位：一次性展开祖先链，避免 N 次 IPC 往返）。
#[tauri::command]
pub fn expand_nodes(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<Affected> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let mut upserted = Vec::with_capacity(ids.len());
    for id in &ids {
        queries::set_collapsed(&tx, id, false, &now())?;
        upserted.push(queries::get_node(&tx, id)?);
    }
    tx.commit()?;
    Ok(Affected {
        upserted,
        removed: Vec::new(),
    })
}

/// 折叠/展开全部（视图操作，不计入撤销历史）。
#[tauri::command]
pub fn collapse_all(state: State<'_, AppState>, collapsed: bool) -> AppResult<Affected> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let upserted = queries::collapse_all(&tx, collapsed, &now())?;
    tx.commit()?;
    Ok(Affected {
        upserted,
        removed: Vec::new(),
    })
}

/// 撤销：返回可直接合并的 patch（无历史时为 null）。
#[tauri::command]
pub fn undo(state: State<'_, AppState>) -> AppResult<Option<Affected>> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let mut history = state.history.lock().expect("history mutex poisoned");
    let patch = history::undo(&tx, &mut history)?;
    tx.commit()?;
    Ok(patch)
}

/// 重做。
#[tauri::command]
pub fn redo(state: State<'_, AppState>) -> AppResult<Option<Affected>> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let mut history = state.history.lock().expect("history mutex poisoned");
    let patch = history::redo(&tx, &mut history)?;
    tx.commit()?;
    Ok(patch)
}

// ───────────────────── 节点复制 / 粘贴（文档内 + 跨文档）─────────────────────
// 剪贴板是 Rust 侧内存快照：切换文档只清撤销历史，不清剪贴板（docs/03 §4）。
// 粘贴保留源节点完成状态（I4 例外），状态传播与历史记录都在同一事务内完成。

/// 复制：把选中节点及其完整子树（含结构与顺序）存入应用内剪贴板。
///
/// 只读操作，不进撤销历史；顺带把缩进纯文本写进系统剪贴板，方便粘到别的应用，
/// 但系统剪贴板写入失败不影响应用内复制（后者才是粘贴的数据源）。
#[tauri::command]
pub fn copy_nodes(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<ClipboardInfo> {
    let doc = state.current.lock().expect("current doc mutex poisoned");
    let index = state.docs.load_index()?;
    let doc_name = index
        .documents
        .iter()
        .find(|d| d.id == doc.id)
        .map(|d| d.name.clone())
        .unwrap_or_default();
    let clip = clipboard::capture(&doc.db.conn, &ids, &doc.id, &doc_name)?;
    let info = clip.info.clone();
    if let Err(err) = crate::commands::agent::write_clipboard_text(&clip.plain_text) {
        eprintln!("写系统剪贴板失败: {err}");
    }
    *state.clipboard.lock().expect("clipboard mutex poisoned") = Some(clip);
    Ok(info)
}

/// 当前剪贴板摘要（无内容时返回 null）：前端据此决定「粘贴」菜单项是否可用。
#[tauri::command]
pub fn clipboard_info(state: State<'_, AppState>) -> AppResult<Option<ClipboardInfo>> {
    let guard = state.clipboard.lock().expect("clipboard mutex poisoned");
    Ok(guard.as_ref().map(|c| c.info.clone()))
}

/// 粘贴：把剪贴板里的所有顶层节点挂为 `parent_id` 的子节点，子孙按原结构整棵重建。
///
/// - 单根模型：绝不会产生第二个根；
/// - 新节点继承源节点的 `status` / `completed_at`（I4 例外）；子树内部原本满足 I2，
///   目标节点与祖先链由 `propagate_upward` 重算：全 done 子树保持父 done，
///   含 pending 子树则让已完成的父回退 pending（CC9）；
/// - 执行态不复制；目标节点折叠时自动展开，保证结果立即可见；
/// - 整次粘贴是一次历史记录，撤销时删除全部新节点并恢复祖先状态。
#[tauri::command]
pub fn paste_nodes(state: State<'_, AppState>, parent_id: String) -> AppResult<PasteResult> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let clip = state
        .clipboard
        .lock()
        .expect("clipboard mutex poisoned")
        .clone()
        .ok_or_else(|| AppError::BadRequest("剪贴板为空，请先复制节点".into()))?;
    if clip.nodes.is_empty() {
        return Err(AppError::BadRequest("剪贴板为空，请先复制节点".into()));
    }

    let tx = doc.db.conn.transaction()?;
    let _ = queries::get_node(&tx, &parent_id)?; // 目标必须存在
    let before = queries::ancestors(&tx, Some(&parent_id))?;
    let base_position = queries::next_position(&tx, Some(&parent_id))?;
    let ts = now();
    let (new_nodes, new_ids) = clipboard::materialize(&clip, &parent_id, base_position, &ts);

    let mut history = state.history.lock().expect("history mutex poisoned");
    let affected = history::run_with_history(&tx, before, &mut history, |tx| {
        for node in &new_nodes {
            queries::insert_node(tx, node)?;
        }
        queries::set_collapsed(tx, &parent_id, false, &ts)?;
        let mut upserted = new_nodes.clone();
        upserted.push(queries::get_node(tx, &parent_id)?);
        upserted.append(&mut propagate::propagate_upward(tx, Some(&parent_id))?);
        // 同一节点可能被传播再次写入：逆序去重，保留最新的一份快照。
        let mut seen = HashSet::new();
        let mut dedup = Vec::with_capacity(upserted.len());
        for node in upserted.into_iter().rev() {
            if seen.insert(node.id.clone()) {
                dedup.push(node);
            }
        }
        dedup.reverse();
        Ok(Affected {
            upserted: dedup,
            removed: Vec::new(),
        })
    })?;
    tx.commit()?;
    Ok(PasteResult { new_ids, affected })
}

//! IPC 命令层（AGENTS.md：薄层——参数校验、事务编排与历史记录；领域逻辑全部在 propagate.rs）。
//! 约定（docs/01 D6）：变更类 command 返回「受影响快照」，前端以返回结果为准受控刷新。
//! 撤销（docs/05 M2）：除视图类（set_collapsed / expand_nodes / collapse_all）外，
//! 所有变更均记录 history entry（before 快照 + after 变更）。
//! v0.3：数据源为「当前文档」（state.current），切换文档不影响其他文档。

use tauri::State;

use crate::db::queries;
use crate::error::AppResult;
use crate::history;
use crate::model::{Affected, CreateResult, Node, NodeStatus};
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
pub fn toggle_status(state: State<'_, AppState>, id: String) -> AppResult<Affected> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let node = queries::get_node(&tx, &id)?;
    let mut before = queries::subtree_nodes(&tx, &id)?;
    before.extend(queries::ancestors(&tx, node.parent_id.as_deref())?);
    let mut history = state.history.lock().expect("history mutex poisoned");
    let affected = history::run_with_history(&tx, before, &mut history, |tx| {
        let upserted = match node.status {
            NodeStatus::Pending => propagate::complete(tx, &id)?,
            NodeStatus::Done => propagate::uncomplete(tx, &id)?,
        };
        Ok(Affected {
            upserted,
            removed: Vec::new(),
        })
    })?;
    tx.commit()?;
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

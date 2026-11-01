//! IPC 命令层（AGENTS.md：薄层——只做参数校验与委托，领域逻辑全部在 propagate.rs）。
//! 约定（docs/01 D6）：变更类 command 返回「受影响快照」，前端以返回结果为准受控刷新。

use tauri::State;

use crate::db::queries;
use crate::error::AppResult;
use crate::model::{Affected, CreateResult, Node, NodeStatus};
use crate::propagate;
use crate::AppState;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 全量树：启动时加载一次，此后靠变更快照增量合并。
#[tauri::command]
pub fn get_tree(state: State<'_, AppState>) -> AppResult<Vec<Node>> {
    let db = state.db.lock().expect("db mutex poisoned");
    queries::all_nodes(&db.conn)
}

/// 创建节点（C1）：父节点为 None 时创建根。
#[tauri::command]
pub fn create_node(
    state: State<'_, AppState>,
    parent_id: Option<String>,
    content: String,
) -> AppResult<CreateResult> {
    let mut db = state.db.lock().expect("db mutex poisoned");
    let tx = db.conn.transaction()?;
    if let Some(pid) = parent_id.as_deref() {
        // 校验父节点存在（不存在 → NodeNotFound，而非 FK 报错）
        let _ = queries::get_node(&tx, pid)?;
    }
    let (new_id, mut upserted) = propagate::create_node(&tx, parent_id.as_deref(), &content)?;
    upserted.push(queries::get_node(&tx, &new_id)?);
    tx.commit()?;
    Ok(CreateResult { new_id, upserted })
}

/// 编辑内容（E1）：不触发任何状态变化。
#[tauri::command]
pub fn update_content(
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> AppResult<Affected> {
    let mut db = state.db.lock().expect("db mutex poisoned");
    let tx = db.conn.transaction()?;
    queries::update_content(&tx, &id, &content, &now())?;
    let node = queries::get_node(&tx, &id)?;
    tx.commit()?;
    Ok(Affected {
        upserted: vec![node],
        removed: Vec::new(),
    })
}

/// 切换状态：pending → complete（M1/M2 级联）；done → uncomplete（M3 级联）。
#[tauri::command]
pub fn toggle_status(state: State<'_, AppState>, id: String) -> AppResult<Affected> {
    let mut db = state.db.lock().expect("db mutex poisoned");
    let tx = db.conn.transaction()?;
    let node = queries::get_node(&tx, &id)?;
    let upserted = match node.status {
        NodeStatus::Pending => propagate::complete(&tx, &id)?,
        NodeStatus::Done => propagate::uncomplete(&tx, &id)?,
    };
    tx.commit()?;
    Ok(Affected {
        upserted,
        removed: Vec::new(),
    })
}

/// 删除节点（D1）：级联删除子孙，返回被删 id 供前端移除快照。
#[tauri::command]
pub fn delete_node(state: State<'_, AppState>, id: String) -> AppResult<Affected> {
    let mut db = state.db.lock().expect("db mutex poisoned");
    let tx = db.conn.transaction()?;
    let (removed, upserted) = propagate::delete_node(&tx, &id)?;
    tx.commit()?;
    Ok(Affected { upserted, removed })
}

/// 折叠/展开（视图状态持久化，docs/02 §1.3 collapsed 字段）。
#[tauri::command]
pub fn set_collapsed(
    state: State<'_, AppState>,
    id: String,
    collapsed: bool,
) -> AppResult<Affected> {
    let mut db = state.db.lock().expect("db mutex poisoned");
    let tx = db.conn.transaction()?;
    queries::set_collapsed(&tx, &id, collapsed, &now())?;
    let node = queries::get_node(&tx, &id)?;
    tx.commit()?;
    Ok(Affected {
        upserted: vec![node],
        removed: Vec::new(),
    })
}

/// 批量展开（平铺视图跳转定位：一次性展开祖先链，避免 N 次 IPC 往返）。
#[tauri::command]
pub fn expand_nodes(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<Affected> {
    let mut db = state.db.lock().expect("db mutex poisoned");
    let tx = db.conn.transaction()?;
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

//! 回收站命令（docs/05 M3：软删除 / 恢复 / 彻底删除 / 清空）。

use std::collections::{HashMap, HashSet};

use tauri::State;

use crate::db::queries;
use crate::error::{AppError, AppResult};
use crate::model::{Affected, Node, TrashItem};
use crate::propagate;
use crate::AppState;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 回收站列表（顶层被删节点 + 被删子孙数）。
#[tauri::command]
pub fn list_trash(state: State<'_, AppState>) -> AppResult<Vec<TrashItem>> {
    let doc = state.current.lock().expect("current doc mutex poisoned");
    queries::trash_items(&doc.db.conn)
}

/// 恢复：恢复该节点整棵子树；若其祖先链仍处于回收站则一并恢复（保证可见）。
#[tauri::command]
pub fn restore_trash(state: State<'_, AppState>, id: String) -> AppResult<Affected> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let node = queries::get_node_any(&tx, &id)?;
    if node.deleted_at.is_none() {
        return Err(AppError::NodeNotFound(id));
    }

    let ts = now();
    let mut restored: Vec<Node> = Vec::new();

    // 1) 祖先链中被删的节点依次恢复（至最近的未删祖先）
    let mut up = node.parent_id.clone();
    while let Some(pid) = up {
        let p = queries::get_node_any(&tx, &pid)?;
        let next = p.parent_id.clone();
        if p.deleted_at.is_some() {
            if let Some(n) = queries::restore_node(&tx, &pid, &ts)? {
                restored.push(n);
            }
            up = next;
        } else {
            break;
        }
    }

    // 2) 恢复自身子树
    restored.extend(queries::restore_subtree(&tx, &id, &ts)?);

    // 3) 对恢复节点的父级做向上传播（去重，幂等）
    let mut parents: HashSet<String> = HashSet::new();
    for n in &restored {
        if let Some(p) = &n.parent_id {
            parents.insert(p.clone());
        }
    }
    for p in parents {
        restored.extend(propagate::propagate_upward(&tx, Some(&p))?);
    }

    // 合并去重（同一节点只保留最新快照）
    let mut map: HashMap<String, Node> = HashMap::new();
    for n in restored {
        map.insert(n.id.clone(), n);
    }
    tx.commit()?;
    Ok(Affected {
        upserted: map.into_values().collect(),
        removed: Vec::new(),
    })
}

/// 彻底删除单条（物理删除子树，不可恢复）。仅允许操作回收站内的节点。
#[tauri::command]
pub fn purge_trash(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    let node = queries::get_node_any(&tx, &id)?;
    if node.deleted_at.is_none() {
        return Err(AppError::NodeNotFound(id));
    }
    queries::delete_node(&tx, &id)?; // ON DELETE CASCADE 清除子孙
    tx.commit()?;
    Ok(())
}

/// 清空回收站。
#[tauri::command]
pub fn empty_trash(state: State<'_, AppState>) -> AppResult<()> {
    let mut doc = state.current.lock().expect("current doc mutex poisoned");
    let tx = doc.db.conn.transaction()?;
    queries::empty_trash(&tx)?;
    tx.commit()?;
    Ok(())
}

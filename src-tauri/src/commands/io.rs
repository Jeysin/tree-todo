//! 导入 / 导出命令（docs/02 §5；格式 snake_case，导入为追加模式 + id 冲突重映射 + 状态校正）。

use std::collections::{HashMap, HashSet};

use tauri::State;

use crate::db::queries;
use crate::error::{AppError, AppResult};
use crate::history;
use crate::model::{Affected, ExportDoc, ImportNode, Node};
use crate::propagate;
use crate::AppState;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 导出全量数据到指定路径（前端经 dialog 选择路径）。
#[tauri::command]
pub fn export_json(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let cur = state.current.lock().expect("current doc mutex poisoned");
    let nodes = queries::all_nodes(&cur.db.conn)?;
    let doc = ExportDoc {
        format: "tree-todo.export".to_string(),
        version: 1,
        exported_at: now(),
        nodes: nodes.iter().map(ImportNode::from).collect(),
    };
    let json = serde_json::to_string_pretty(&doc)
        .map_err(|e| AppError::ImportFormat(format!("序列化失败: {e}")))?;
    std::fs::write(&path, json)?;
    Ok(())
}

/// 从指定路径导入（追加模式）：
/// - 与现有数据 id 冲突的节点重新生成 id（并重映射子节点 parent_id）；
/// - 每个导入根作为新根追加；
/// - 导入后强制状态校正（docs/02 §5：以子节点聚合为准）；
/// - 整体作为一次可撤销操作进入历史。
#[tauri::command]
pub fn import_json(state: State<'_, AppState>, path: String) -> AppResult<Affected> {
    let raw = std::fs::read_to_string(&path)?;
    let doc: ExportDoc = serde_json::from_str(&raw)
        .map_err(|e| AppError::ImportFormat(format!("JSON 解析失败: {e}")))?;
    if doc.format != "tree-todo.export" {
        return Err(AppError::ImportFormat("不是 tree-todo 导出文件".into()));
    }
    if doc.version != 1 {
        return Err(AppError::ImportFormat(format!(
            "不支持的版本: {}",
            doc.version
        )));
    }
    if doc.nodes.is_empty() {
        return Err(AppError::ImportFormat("文件不包含任何节点".into()));
    }

    let mut cur = state.current.lock().expect("current doc mutex poisoned");
    let tx = cur.db.conn.transaction()?;

    // 1) id 冲突检测与重映射
    let existing: HashSet<String> = queries::all_nodes(&tx)?
        .into_iter()
        .map(|n| n.id)
        .collect();
    let mut id_map: HashMap<String, String> = HashMap::new();
    for n in &doc.nodes {
        if existing.contains(&n.id) {
            id_map.insert(n.id.clone(), uuid::Uuid::new_v4().to_string());
        }
    }
    let ids_in_doc: HashSet<&str> = doc.nodes.iter().map(|n| n.id.as_str()).collect();

    // 2) 构建节点：文件内无父的顶层节点，统一挂到当前文档的根任务下（单根模型）
    let root = queries::root_id(&tx)?;
    if root.is_none() {
        return Err(AppError::RootProtected);
    }
    let mut new_nodes: Vec<Node> = Vec::with_capacity(doc.nodes.len());
    let mut import_roots: Vec<String> = Vec::new();
    for n in &doc.nodes {
        let new_id = id_map.get(&n.id).cloned().unwrap_or_else(|| n.id.clone());
        let parent = match n.parent_id.as_deref() {
            Some(p) if ids_in_doc.contains(p) => {
                Some(id_map.get(p).cloned().unwrap_or_else(|| p.to_string()))
            }
            _ => root.clone(),
        };
        if parent.as_deref() == root.as_deref() {
            import_roots.push(new_id.clone());
        }
        let mut node = n.clone().into_node();
        node.id = new_id;
        node.parent_id = parent;
        new_nodes.push(node);
    }

    // 3) 顶层导入节点 position 顺延到根任务现有子节点之后
    let mut next = queries::next_position(&tx, root.as_deref())?;
    for node in new_nodes.iter_mut() {
        if import_roots.contains(&node.id) {
            node.position = next;
            next += 1024.0;
        }
    }

    // 4) 父先子排序插入 + 状态校正（整个导入记为一次可撤销操作）
    //    根节点状态可能被导入子树改变，因此 before 必须包含根。
    let before: Vec<Node> = match root.as_deref() {
        Some(r) => vec![queries::get_node(&tx, r)?],
        None => Vec::new(),
    };
    let mut history = state.history.lock().expect("history mutex poisoned");
    let affected = history::run_with_history(&tx, before, &mut history, |tx| {
        history::sort_parents_first(&mut new_nodes);
        let mut upserted: Vec<Node> = Vec::with_capacity(new_nodes.len());
        for n in &new_nodes {
            queries::upsert_node(tx, n)?;
            upserted.push(n.clone());
        }
        if let Some(r) = root.as_deref() {
            upserted.extend(propagate::recompute_subtree(tx, r)?);
        } else {
            for r in &import_roots {
                upserted.extend(propagate::recompute_subtree(tx, r)?);
            }
        }
        // 导入的顶层节点若 status 与聚合不一致，recompute 已修正；确保返回值包含最新快照
        Ok(Affected {
            upserted,
            removed: Vec::new(),
        })
    })?;
    tx.commit()?;
    Ok(affected)
}

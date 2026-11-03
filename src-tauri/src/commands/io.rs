//! 导入 / 导出（v0.5）：以「文档 / 目录 / 全部」为单位的打包导出与整体还原。
//!
//! 约定（docs/02 §5）：
//! - 导出与导入互逆：导出的是整个文档或整个目录，导入就还原成整个文档或目录；
//! - **不做**「追加到现有文档」的导入；
//! - 导入时强制跑一次全树状态传播校正，不信任文件里的 status。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::Connection;
use tauri::State;
use uuid::Uuid;

use crate::db::{exec, queries, Db};
use crate::error::{AppError, AppResult};
use crate::history;
use crate::model::{
    BundleDocument, BundleFolder, DocIndex, ExportBundle, ExportDoc, ImportNode, ImportResult, Node,
    NodeStatus, BUNDLE_FORMAT, BUNDLE_VERSION,
};
use crate::propagate;
use crate::storage::DocStore;
use crate::AppState;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn write_bundle(path: &str, bundle: &ExportBundle) -> AppResult<()> {
    let json = serde_json::to_string_pretty(bundle)
        .map_err(|e| AppError::ImportFormat(format!("序列化失败: {e}")))?;
    std::fs::write(path, json)?;
    Ok(())
}

/// 只读导出某个文档的全部节点（不触发建根 / 迁移等写操作）。
fn read_document_nodes(store: &DocStore, id: &str) -> AppResult<Vec<ImportNode>> {
    let path = store.db_path(id);
    if !path.exists() {
        return Err(AppError::NodeNotFound(format!("文档 {id}")));
    }
    let conn = Connection::open(&path)?;
    let nodes = queries::all_nodes(&conn)?;
    Ok(nodes.iter().map(ImportNode::from).collect())
}

fn build_folder(index: &DocIndex, store: &DocStore, folder_id: &str) -> AppResult<BundleFolder> {
    let meta = index
        .folders
        .iter()
        .find(|f| f.id == folder_id)
        .ok_or_else(|| AppError::NodeNotFound(format!("目录 {folder_id}")))?;
    let mut folders = Vec::new();
    for child in index
        .folders
        .iter()
        .filter(|f| f.parent_id.as_deref() == Some(folder_id))
    {
        folders.push(build_folder(index, store, &child.id)?);
    }
    let mut documents = Vec::new();
    for d in index
        .documents
        .iter()
        .filter(|d| d.folder_id.as_deref() == Some(folder_id))
    {
        documents.push(BundleDocument {
            name: d.name.clone(),
            nodes: read_document_nodes(store, &d.id)?,
        });
    }
    Ok(BundleFolder {
        name: meta.name.clone(),
        folders,
        documents,
    })
}

/// 导出单个文档。
#[tauri::command]
pub fn export_document(state: State<'_, AppState>, id: String, path: String) -> AppResult<()> {
    let index = state.docs.load_index()?;
    let meta = index
        .documents
        .iter()
        .find(|d| d.id == id)
        .ok_or_else(|| AppError::NodeNotFound(format!("文档 {id}")))?;
    let bundle = ExportBundle {
        format: BUNDLE_FORMAT.to_string(),
        version: BUNDLE_VERSION,
        exported_at: now(),
        kind: "document".to_string(),
        document: Some(BundleDocument {
            name: meta.name.clone(),
            nodes: read_document_nodes(&state.docs, &id)?,
        }),
        ..Default::default()
    };
    write_bundle(&path, &bundle)
}

/// 导出整个目录（含子目录与其中所有文档）。
#[tauri::command]
pub fn export_folder(state: State<'_, AppState>, id: String, path: String) -> AppResult<()> {
    let index = state.docs.load_index()?;
    let folder = build_folder(&index, &state.docs, &id)?;
    let bundle = ExportBundle {
        format: BUNDLE_FORMAT.to_string(),
        version: BUNDLE_VERSION,
        exported_at: now(),
        kind: "folder".to_string(),
        folder: Some(folder),
        ..Default::default()
    };
    write_bundle(&path, &bundle)
}

/// 导出全部：根层级的目录与文档（不含回收站）。
#[tauri::command]
pub fn export_all(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let index = state.docs.load_index()?;
    let mut folders = Vec::new();
    for f in index.folders.iter().filter(|f| f.parent_id.is_none()) {
        folders.push(build_folder(&index, &state.docs, &f.id)?);
    }
    let mut documents = Vec::new();
    for d in index.documents.iter().filter(|d| d.folder_id.is_none()) {
        documents.push(BundleDocument {
            name: d.name.clone(),
            nodes: read_document_nodes(&state.docs, &d.id)?,
        });
    }
    let bundle = ExportBundle {
        format: BUNDLE_FORMAT.to_string(),
        version: BUNDLE_VERSION,
        exported_at: now(),
        kind: "all".to_string(),
        folders,
        documents,
        ..Default::default()
    };
    write_bundle(&path, &bundle)
}

/// 导入一个导出包，整体还原为新的文档 / 目录（可指定落在哪个目录下）。
#[tauri::command]
pub fn import_bundle(
    state: State<'_, AppState>,
    path: String,
    folder_id: Option<String>,
) -> AppResult<ImportResult> {
    let raw = std::fs::read_to_string(&path)?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| AppError::ImportFormat(format!("JSON 解析失败: {e}")))?;
    let format = value
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let index = state.docs.load_index()?;
    if let Some(fid) = folder_id.as_deref()
        && !index.folders.iter().any(|f| f.id == fid)
    {
        return Err(AppError::NodeNotFound(format!("目录 {fid}")));
    }

    // v1 单文档（{format, version:1, nodes}）：当作「一个文档」导入，兼容老文件。
    if format == "tree-todo.export" {
        let old: ExportDoc = serde_json::from_value(value)
            .map_err(|e| AppError::ImportFormat(format!("文件结构不正确: {e}")))?;
        if old.version != 1 {
            return Err(AppError::ImportFormat(format!(
                "不支持的版本: {}",
                old.version
            )));
        }
        let name = Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("导入文档")
            .to_string();
        let id = import_document(
            &state.docs,
            folder_id,
            &BundleDocument {
                name,
                nodes: old.nodes,
            },
        )?;
        return Ok(ImportResult {
            document_ids: vec![id.clone()],
            folder_ids: Vec::new(),
            first_document_id: Some(id),
        });
    }

    let bundle: ExportBundle = serde_json::from_value(value)
        .map_err(|e| AppError::ImportFormat(format!("文件结构不正确: {e}")))?;
    if bundle.format != BUNDLE_FORMAT {
        return Err(AppError::ImportFormat("不是 tree-todo 导出文件".into()));
    }
    if bundle.version != 2 && bundle.version != BUNDLE_VERSION {
        return Err(AppError::ImportFormat(format!(
            "不支持的版本: {}",
            bundle.version
        )));
    }

    let mut result = ImportResult {
        document_ids: Vec::new(),
        folder_ids: Vec::new(),
        first_document_id: None,
    };
    match bundle.kind.as_str() {
        "document" => {
            let doc = bundle
                .document
                .ok_or_else(|| AppError::ImportFormat("缺少 document 字段".into()))?;
            let id = import_document(&state.docs, folder_id, &doc)?;
            result.document_ids.push(id.clone());
            result.first_document_id = Some(id);
        }
        "folder" => {
            let folder = bundle
                .folder
                .ok_or_else(|| AppError::ImportFormat("缺少 folder 字段".into()))?;
            import_folder(&state.docs, folder_id, &folder, &mut result)?;
        }
        "all" => {
            for folder in &bundle.folders {
                import_folder(&state.docs, folder_id.clone(), folder, &mut result)?;
            }
            for doc in &bundle.documents {
                let id = import_document(&state.docs, folder_id.clone(), doc)?;
                result.document_ids.push(id.clone());
                if result.first_document_id.is_none() {
                    result.first_document_id = Some(id);
                }
            }
        }
        other => {
            return Err(AppError::ImportFormat(format!(
                "未知的导出类型: {other}"
            )))
        }
    }
    Ok(result)
}

fn import_folder(
    store: &DocStore,
    parent: Option<String>,
    folder: &BundleFolder,
    out: &mut ImportResult,
) -> AppResult<String> {
    let meta = store.create_folder(&folder.name, parent)?;
    out.folder_ids.push(meta.id.clone());
    for child in &folder.folders {
        import_folder(store, Some(meta.id.clone()), child, out)?;
    }
    for doc in &folder.documents {
        let id = import_document(store, Some(meta.id.clone()), doc)?;
        out.document_ids.push(id.clone());
        if out.first_document_id.is_none() {
            out.first_document_id = Some(id);
        }
    }
    Ok(meta.id)
}

fn import_document(
    store: &DocStore,
    folder_id: Option<String>,
    doc: &BundleDocument,
) -> AppResult<String> {
    let meta = store.create(&doc.name, folder_id)?;
    if let Err(e) = fill_document(store, &meta.id, &doc.nodes) {
        // 导入失败：回收半成品，避免留下空文档。
        let _ = store.discard(&meta.id);
        return Err(e);
    }
    Ok(meta.id)
}

/// 把导出的节点整体写入一个新文档（覆盖式，不追加）。
fn fill_document(store: &DocStore, doc_id: &str, nodes: &[ImportNode]) -> AppResult<()> {
    let path = store.db_path(doc_id);
    let mut db = Db::open(&path)?;
    let tx = db.conn.transaction()?;
    tx.execute("DELETE FROM nodes", [])?;
    tx.execute("DELETE FROM run_nodes", [])?;
    tx.execute("DELETE FROM runs", [])?;
    let mut list: Vec<Node> = nodes.iter().cloned().map(ImportNode::into_node).collect();
    normalize_nodes(&mut list);
    history::sort_parents_first(&mut list);
    for node in &list {
        queries::upsert_node(&tx, node)?;
        if let Some(execution) = &node.execution {
            exec::apply_imported(&tx, &node.id, execution)?;
        }
    }
    if let Some(root) = queries::root_id(&tx)? {
        propagate::recompute_subtree(&tx, &root)?;
    }
    tx.commit()?;
    Ok(())
}

/// 导入文件的单根归一：补齐时间戳、修掉悬空父引用与环、保证只有一个根。
fn normalize_nodes(list: &mut Vec<Node>) {
    let ts = now();
    for node in list.iter_mut() {
        if node.created_at.is_empty() {
            node.created_at = ts.clone();
        }
        if node.updated_at.is_empty() {
            node.updated_at = ts.clone();
        }
        if node.status == NodeStatus::Done && node.completed_at.is_none() {
            node.completed_at = Some(node.updated_at.clone());
        }
        node.deleted_at = None;
    }

    let ids: HashSet<String> = list.iter().map(|n| n.id.clone()).collect();
    let parents: HashMap<String, Option<String>> = list
        .iter()
        .map(|n| (n.id.clone(), n.parent_id.clone()))
        .collect();
    let count = list.len();

    for node in list.iter_mut() {
        // 悬空父引用 / 自引用 → 交给根
        if let Some(p) = node.parent_id.clone()
            && (p == node.id || !ids.contains(&p))
        {
            node.parent_id = None;
        }
        // 环检测：沿父链上行，超过节点数仍未结束即判定成环
        let mut cursor = node.parent_id.clone();
        let mut steps = 0usize;
        while let Some(p) = cursor {
            steps += 1;
            if p == node.id || steps > count {
                node.parent_id = None;
                break;
            }
            cursor = parents.get(&p).cloned().flatten();
        }
    }

    let root_count = list.iter().filter(|n| n.parent_id.is_none()).count();
    if root_count != 1 {
        let root_id = Uuid::new_v4().to_string();
        for node in list.iter_mut() {
            if node.parent_id.is_none() {
                node.parent_id = Some(root_id.clone());
            }
        }
        list.push(Node {
            id: root_id,
            parent_id: None,
            content: "任务线".to_string(),
            note: String::new(),
            status: NodeStatus::Pending,
            position: 0.0,
            collapsed: false,
            created_at: ts.clone(),
            updated_at: ts,
            deleted_at: None,
            completed_at: None,
            execution: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, parent: Option<&str>, status: NodeStatus) -> Node {
        Node {
            id: id.to_string(),
            parent_id: parent.map(str::to_string),
            content: id.to_string(),
            note: String::new(),
            status,
            position: 0.0,
            collapsed: false,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
            completed_at: None,
            execution: None,
        }
    }

    fn assert_single_root(list: &[Node]) {
        let ids: HashSet<&str> = list.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(list.iter().filter(|n| n.parent_id.is_none()).count(), 1);
        // 父引用必须存在，且沿父链一定能走到根（说明无环）
        for n in list {
            let mut cursor = n.parent_id.as_deref();
            let mut steps = 0;
            while let Some(p) = cursor {
                assert!(ids.contains(p), "悬空父引用 {p}");
                steps += 1;
                assert!(steps <= list.len(), "父链成环");
                cursor = list.iter().find(|x| x.id == p).unwrap().parent_id.as_deref();
            }
        }
    }

    #[test]
    fn normalize_wraps_multiple_roots() {
        let mut list = vec![
            node("a", None, NodeStatus::Pending),
            node("b", None, NodeStatus::Pending),
        ];
        normalize_nodes(&mut list);
        assert_eq!(list.len(), 3);
        assert_single_root(&list);
    }

    #[test]
    fn normalize_breaks_cycles() {
        let mut list = vec![
            node("a", Some("b"), NodeStatus::Pending),
            node("b", Some("a"), NodeStatus::Pending),
            node("root", None, NodeStatus::Pending),
        ];
        normalize_nodes(&mut list);
        assert_single_root(&list);
    }

    #[test]
    fn normalize_fixes_dangling_parent_and_timestamps() {
        let mut list = vec![
            node("root", None, NodeStatus::Pending),
            node("orphan", Some("missing"), NodeStatus::Done),
        ];
        normalize_nodes(&mut list);
        assert_single_root(&list);
        let orphan = list.iter().find(|n| n.id == "orphan").unwrap();
        assert!(!orphan.created_at.is_empty());
        assert!(orphan.completed_at.is_some());
    }

    fn imported(id: &str, parent: Option<&str>, content: &str) -> ImportNode {
        ImportNode {
            id: id.to_string(),
            parent_id: parent.map(str::to_string),
            content: content.to_string(),
            note: String::new(),
            status: "pending".to_string(),
            position: 1024.0,
            collapsed: false,
            created_at: "2026-01-01T00:00:00+00:00".to_string(),
            updated_at: "2026-01-01T00:00:00+00:00".to_string(),
            completed_at: None,
            execution: None,
        }
    }

    /// 导出 → 导入到新文档：节点、父子关系与单根约束都要还原。
    #[test]
    fn document_export_import_roundtrip() {
        let dir = std::env::temp_dir().join(format!("tree-todo-bundle-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = DocStore::new(dir.clone());
        store.ensure().unwrap();

        let source = store.create("源文档", None).unwrap();
        let nodes = vec![
            imported("r", None, "任务线"),
            imported("a", Some("r"), "买域名"),
            imported("b", Some("a"), "选后缀"),
        ];
        fill_document(&store, &source.id, &nodes).unwrap();

        let exported = read_document_nodes(&store, &source.id).unwrap();
        assert_eq!(exported.len(), 3);
        assert_eq!(exported.iter().filter(|n| n.parent_id.is_none()).count(), 1);

        let target = store.create("目标文档", None).unwrap();
        fill_document(&store, &target.id, &exported).unwrap();
        let restored = read_document_nodes(&store, &target.id).unwrap();
        assert_eq!(restored.len(), 3);
        assert_eq!(
            restored
                .iter()
                .find(|n| n.id == "b")
                .unwrap()
                .parent_id
                .as_deref(),
            Some("a")
        );
        assert_eq!(
            restored.iter().filter(|n| n.parent_id.is_none()).count(),
            1
        );

        // Windows 上 RemoveDirectory 可能因变更通知延迟报「目录不是空的」（目录实际已空），
        // 重试即可；清理失败不影响测试结论。
        for _ in 0..10 {
            if std::fs::remove_dir_all(&dir).is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}

//! 节点复制 / 粘贴（文档内 + 跨文档）。
//!
//! 设计要点（AGENTS.md 领域红线）：
//! - 剪贴板是 **Rust 侧内存快照**（`AppState.clipboard`），前端不持有第二份数据；
//!   切换文档只清撤销历史、不清剪贴板，因此天然支持跨文档粘贴。
//! - 快照是自描述的扁平列表：`sourceId` / `parentSourceId` 记录原树结构，
//!   顶层节点的 `parentSourceId` 为 `None`；粘贴时为每个节点重新分配 UUID，
//!   按 old→new 映射重建父子关系，顶层节点一律挂到目标节点下。
//! - 粘贴**保留源节点的完成状态**（`status` + `completed_at`，I4 的复制例外）；
//!   执行态（`exec_*` / run 账本）不复制，避免运行记录与节点一对一关系被破坏。
//!   子树原样取自一个合法状态，内部天然满足 I2；目标父及祖先链由
//!   `propagate::propagate_upward` 在**同一事务**内重算，保证粘贴后全树仍满足 I2。
//! - 本模块为纯数据逻辑，不依赖 Tauri 类型，可独立单元测试。

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;
use uuid::Uuid;

use crate::db::queries;
use crate::error::{AppError, AppResult};
use crate::model::{Node, NodeStatus};

/// 与 `queries::next_position` 的步长保持一致：多个顶层节点依次追加到目标末尾。
const POSITION_STEP: f64 = 1024.0;

/// 剪贴板中的一个节点快照（不含任何运行时状态）。
#[derive(Debug, Clone)]
pub struct ClipNode {
    /// 原节点 id：只作为快照内部的父引用，粘贴时会被替换成全新 UUID。
    pub source_id: String,
    /// `None` = 剪贴板里的顶层节点（粘贴后成为目标节点的直接子节点）。
    pub parent_source_id: Option<String>,
    pub content: String,
    pub note: String,
    pub position: f64,
    pub collapsed: bool,
    /// 源节点的完成状态：按产品要求「连完成状态一起复制」（I4 例外）。
    pub status: NodeStatus,
    /// 完成时间随状态一起保留，统计面板「最近 7 天完成」不因复制而丢数据。
    pub completed_at: Option<String>,
    /// 相对顶层的深度：只用于生成系统剪贴板的缩进纯文本。
    pub depth: usize,
}

/// 剪贴板摘要（前端用于 toast / 右键菜单的可用态与文案）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardInfo {
    /// 顶层节点数 = 粘贴后新增的直接子节点数。
    pub node_count: usize,
    /// 含全部子孙的节点总数。
    pub total_count: usize,
    /// 简短摘要，如「买域名」「买域名 等 3 项」。
    pub summary: String,
    pub source_doc_id: String,
    pub source_doc_name: String,
}

/// 应用内节点剪贴板：一次复制 = 若干棵完整子树。
#[derive(Debug, Clone)]
pub struct Clipboard {
    /// DFS 前序（父先子），同级按 `position` 排序，可直接顺序插入。
    pub nodes: Vec<ClipNode>,
    pub info: ClipboardInfo,
    /// 写进系统剪贴板的缩进纯文本：方便把任务清单粘到别的应用，不参与应用内粘贴。
    pub plain_text: String,
}

/// 从当前文档捕获若干节点的完整子树快照。
///
/// - 重复 id 去重；祖先已被选中的后代会被剔除，避免同一棵子树复制两遍；
/// - 保留 content / note / position / collapsed、完整父子结构，以及 `status` / `completed_at`；
/// - 执行态（`exec_*` 与 run 账本）**不进快照**：它绑定具体运行记录，复制会让一条 run 关联到多个节点。
pub fn capture(
    conn: &Connection,
    ids: &[String],
    source_doc_id: &str,
    source_doc_name: &str,
) -> AppResult<Clipboard> {
    let mut unique = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        if seen.insert(id.clone()) {
            unique.push(id.clone());
        }
    }
    if unique.is_empty() {
        return Err(AppError::BadRequest("没有选中的节点".into()));
    }
    // 所有选中节点必须存在（不存在 → NodeNotFound）。
    for id in &unique {
        let _ = queries::get_node(conn, id)?;
    }
    let selected: HashSet<String> = unique.iter().cloned().collect();

    // 剔除「祖先也在选区里」的 id：复制祖先时其子树本就整体带走。
    let mut top_ids = Vec::new();
    for id in &unique {
        let covered = queries::ancestors(conn, Some(id))?
            .iter()
            .skip(1)
            .any(|a| selected.contains(&a.id));
        if !covered {
            top_ids.push(id.clone());
        }
    }
    let top_set: HashSet<String> = top_ids.iter().cloned().collect();

    let mut all = Vec::new();
    for id in &top_ids {
        all.extend(queries::subtree_nodes(conn, id)?);
    }

    let by_id: HashMap<String, Node> = all
        .iter()
        .map(|n| (n.id.clone(), n.clone()))
        .collect();
    // 顶层节点的父在快照之外（可能指向树外节点），统一归入 None 组。
    let mut by_parent: HashMap<Option<String>, Vec<Node>> = HashMap::new();
    for n in all {
        let key = if top_set.contains(&n.id) {
            None
        } else {
            n.parent_id.clone()
        };
        by_parent.entry(key).or_default().push(n);
    }
    for group in by_parent.values_mut() {
        group.sort_by(|a, b| a.position.total_cmp(&b.position));
    }

    let mut nodes = Vec::with_capacity(by_id.len());
    let mut visited = HashSet::new();
    if let Some(roots) = by_parent.get(&None).cloned() {
        for root in roots {
            emit(
                &root.id,
                None,
                0,
                &by_parent,
                &by_id,
                &mut visited,
                &mut nodes,
            );
        }
    }

    let label = nodes
        .first()
        .map(|n| n.content.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("未命名");
    let short: String = label.chars().take(18).collect();
    let head = if label.chars().count() > 18 {
        format!("{short}…")
    } else {
        short
    };
    let summary = if top_ids.len() > 1 {
        format!("{head} 等 {} 项", top_ids.len())
    } else {
        head
    };

    let plain_text = nodes
        .iter()
        .map(|n| {
            let text = n.content.trim();
            let label = if text.is_empty() { "未命名" } else { text };
            format!("{}{}", "  ".repeat(n.depth), label)
        })
        .collect::<Vec<_>>()
        .join("\n");

    Ok(Clipboard {
        info: ClipboardInfo {
            node_count: top_ids.len(),
            total_count: nodes.len(),
            summary,
            source_doc_id: source_doc_id.to_string(),
            source_doc_name: source_doc_name.to_string(),
        },
        plain_text,
        nodes,
    })
}

/// DFS 前序输出快照节点；`visited` 防止异常数据成环导致无限递归。
#[allow(clippy::too_many_arguments)]
fn emit(
    id: &str,
    parent_source_id: Option<String>,
    depth: usize,
    by_parent: &HashMap<Option<String>, Vec<Node>>,
    by_id: &HashMap<String, Node>,
    visited: &mut HashSet<String>,
    out: &mut Vec<ClipNode>,
) {
    if !visited.insert(id.to_string()) {
        return;
    }
    let Some(node) = by_id.get(id) else {
        return;
    };
    out.push(ClipNode {
        source_id: node.id.clone(),
        parent_source_id,
        content: node.content.clone(),
        note: node.note.clone(),
        position: node.position,
        collapsed: node.collapsed,
        status: node.status,
        completed_at: node.completed_at.clone(),
        depth,
    });
    if let Some(children) = by_parent.get(&Some(id.to_string())) {
        for child in children {
            emit(
                &child.id,
                Some(id.to_string()),
                depth + 1,
                by_parent,
                by_id,
                visited,
                out,
            );
        }
    }
}

/// 把剪贴板快照展开成待插入的新节点（父先子顺序）。
///
/// `parent_id` 是粘贴目标；`base_position` 是目标节点当前的同级末尾位置。
/// 返回 `(新节点列表, 顶层新节点 id 列表)`，后者供前端选中 / 高亮。
pub fn materialize(
    clip: &Clipboard,
    parent_id: &str,
    base_position: f64,
    ts: &str,
) -> (Vec<Node>, Vec<String>) {
    let mut id_map: HashMap<String, String> = HashMap::new();
    for n in &clip.nodes {
        id_map.insert(n.source_id.clone(), Uuid::new_v4().to_string());
    }

    let mut new_ids = Vec::new();
    let mut out = Vec::with_capacity(clip.nodes.len());
    let mut top_index = 0usize;
    for n in &clip.nodes {
        let new_id = id_map
            .get(&n.source_id)
            .cloned()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let (new_parent, position) = match &n.parent_source_id {
            None => {
                new_ids.push(new_id.clone());
                let pos = base_position + top_index as f64 * POSITION_STEP;
                top_index += 1;
                (parent_id.to_string(), pos)
            }
            Some(p) => (
                id_map.get(p).cloned().unwrap_or_else(|| parent_id.to_string()),
                n.position,
            ),
        };
        out.push(Node {
            id: new_id,
            // 单根模型：粘贴永远作为子任务，绝不产生第二个根。
            parent_id: Some(new_parent),
            content: n.content.clone(),
            note: n.note.clone(),
            // I4 例外：复制出来的节点继承源节点的完成状态与完成时间。
            status: n.status,
            position,
            collapsed: n.collapsed,
            created_at: ts.to_string(),
            updated_at: ts.to_string(),
            deleted_at: None,
            completed_at: n.completed_at.clone(),
            execution: None,
        });
    }
    (out, new_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::history;
    use crate::model::Affected;
    use crate::propagate;

    const TS: &str = "2026-01-01T00:00:00+00:00";

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn create(db: &Db, parent: Option<&str>, content: &str) -> String {
        let tx = db.conn.unchecked_transaction().unwrap();
        let (id, _) = propagate::create_node_at(&tx, parent, content, None).unwrap();
        tx.commit().unwrap();
        id
    }

    fn status(db: &Db, id: &str) -> NodeStatus {
        queries::get_node(&db.conn, id).unwrap().status
    }

    /// CP1：复制父节点带走整棵子树，顺序 = DFS 前序 + 同级 position。
    #[test]
    fn c01_capture_keeps_whole_subtree_and_order() {
        let db = db();
        let a = create(&db, None, "A");
        let b = create(&db, Some(&a), "B");
        let c = create(&db, Some(&b), "C");
        let d = create(&db, Some(&a), "D");

        let clip = capture(&db.conn, std::slice::from_ref(&a), "doc1", "文档一").unwrap();
        assert_eq!(clip.info.node_count, 1);
        assert_eq!(clip.info.total_count, 4);
        let contents: Vec<&str> = clip.nodes.iter().map(|n| n.content.as_str()).collect();
        assert_eq!(contents, vec!["A", "B", "C", "D"]);
        assert_eq!(clip.nodes[0].parent_source_id, None);
        assert_eq!(clip.nodes[1].parent_source_id.as_deref(), Some(a.as_str()));
        assert_eq!(clip.nodes[2].parent_source_id.as_deref(), Some(b.as_str()));
        assert_eq!(clip.nodes[3].parent_source_id.as_deref(), Some(a.as_str()));
        assert_eq!(clip.plain_text, "A\n  B\n    C\n  D");
        assert_eq!(clip.nodes[2].depth, 2);
        let _ = (c, d);
    }

    /// CP2：多选时祖先已选中的后代被剔除，多棵树按 position 保序。
    #[test]
    fn c02_capture_dedups_covered_descendants() {
        let db = db();
        let root = create(&db, None, "R");
        let a = create(&db, Some(&root), "A");
        let b = create(&db, Some(&a), "B");
        let e = create(&db, Some(&root), "E");

        let clip = capture(&db.conn, &[a.clone(), b.clone(), e.clone(), a.clone()], "d", "文档")
            .unwrap();
        assert_eq!(clip.info.node_count, 2);
        assert_eq!(clip.info.total_count, 3);
        let tops: Vec<&str> = clip
            .nodes
            .iter()
            .filter(|n| n.parent_source_id.is_none())
            .map(|n| n.content.as_str())
            .collect();
        assert_eq!(tops, vec!["A", "E"]);
        assert_eq!(clip.info.summary, "A 等 2 项");
    }

    /// CP3：完成状态随节点一起复制——全新 id、status / completed_at 保留、执行态清空、父子重映射。
    #[test]
    fn c03_materialize_keeps_status_and_remaps_parents() {
        let db = db();
        let root = create(&db, None, "R");
        let a = create(&db, Some(&root), "A");
        let b = create(&db, Some(&a), "B");
        {
            let tx = db.conn.unchecked_transaction().unwrap();
            queries::update_note(&tx, &a, "备注内容", TS).unwrap();
            propagate::complete(&tx, &b).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(status(&db, &a), NodeStatus::Done, "B 完成应级联 A、R done");

        let clip = capture(&db.conn, std::slice::from_ref(&a), "d", "文档").unwrap();
        let (nodes, new_ids) = materialize(&clip, "TARGET", 9000.0, TS);
        assert_eq!(nodes.len(), 2);
        assert_eq!(new_ids.len(), 1);
        assert!(!nodes.iter().any(|n| n.id == a || n.id == b), "必须重新分配 id");
        assert!(nodes.iter().all(|n| n.status == NodeStatus::Done), "完成状态应整体保留");
        assert!(nodes.iter().all(|n| n.completed_at.is_some()), "completed_at 应随 done 一起保留");
        assert!(nodes.iter().all(|n| n.execution.is_none()), "执行态不复制");
        let top = &nodes[0];
        assert_eq!(top.parent_id.as_deref(), Some("TARGET"));
        assert_eq!(top.content, "A");
        assert_eq!(top.note, "备注内容");
        assert!((top.position - 9000.0).abs() < f64::EPSILON);
        let child = &nodes[1];
        assert_eq!(child.parent_id.as_deref(), Some(top.id.as_str()));
        assert_eq!(child.content, "B");
    }

    /// CP4：多个顶层节点依次追加到目标末尾，position 不冲突。
    #[test]
    fn c04_materialize_multiple_tops_append_in_order() {
        let db = db();
        let root = create(&db, None, "R");
        let a = create(&db, Some(&root), "A");
        let b = create(&db, Some(&root), "B");
        let clip = capture(&db.conn, &[a, b], "d", "文档").unwrap();
        let (nodes, new_ids) = materialize(&clip, "TARGET", 500.0, TS);
        assert_eq!(new_ids.len(), 2);
        assert_eq!(nodes[0].position, 500.0);
        assert_eq!(nodes[1].position, 500.0 + POSITION_STEP);
        assert!(nodes.iter().all(|n| n.parent_id.as_deref() == Some("TARGET")));
    }

    /// CP5：跨文档粘贴 = 新文档里重建整棵子树；CC1 让 done 目标回退 pending；撤销整体回滚。
    #[test]
    fn c05_paste_across_documents_propagates_and_undo_removes_copy() {
        let src = db();
        let src_root = create(&src, None, "源根");
        let a = create(&src, Some(&src_root), "A");
        let _b = create(&src, Some(&a), "B");
        let clip = capture(&src.conn, &[a], "doc-src", "源文档").unwrap();
        assert_eq!(clip.info.source_doc_name, "源文档");

        let dst = db();
        let target = create(&dst, None, "目标根");
        {
            let tx = dst.conn.unchecked_transaction().unwrap();
            propagate::complete(&tx, &target).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(status(&dst, &target), NodeStatus::Done);

        // 与 commands::paste_nodes 相同的事务编排。
        let tx = dst.conn.unchecked_transaction().unwrap();
        let before = queries::ancestors(&tx, Some(&target)).unwrap();
        let base = queries::next_position(&tx, Some(&target)).unwrap();
        let (new_nodes, new_ids) = materialize(&clip, &target, base, TS);
        let mut history = history::History::new();
        let _after = history::run_with_history(&tx, before, &mut history, |tx| {
            for n in &new_nodes {
                queries::insert_node(tx, n)?;
            }
            queries::set_collapsed(tx, &target, false, TS)?;
            let mut upserted = new_nodes.clone();
            upserted.push(queries::get_node(tx, &target)?);
            upserted.append(&mut propagate::propagate_upward(tx, Some(&target))?);
            Ok(Affected {
                upserted,
                removed: Vec::new(),
            })
        })
        .unwrap();
        tx.commit().unwrap();

        assert_eq!(new_ids.len(), 1);
        assert_eq!(queries::all_nodes(&dst.conn).unwrap().len(), 3, "目标根 + A' + B'");
        assert_eq!(
            status(&dst, &target),
            NodeStatus::Pending,
            "CC1：done 目标新增 pending 子后必须回退"
        );
        let top = queries::get_node(&dst.conn, &new_ids[0]).unwrap();
        assert_eq!(top.parent_id.as_deref(), Some(target.as_str()));
        assert_eq!(queries::child_count(&dst.conn, &top.id).unwrap(), 1);

        let tx = dst.conn.unchecked_transaction().unwrap();
        let patch = history::undo(&tx, &mut history).unwrap().unwrap();
        tx.commit().unwrap();
        assert_eq!(patch.removed.len(), 2, "undo 应删除两个新节点");
        assert_eq!(queries::all_nodes(&dst.conn).unwrap().len(), 1);
        assert_eq!(status(&dst, &target), NodeStatus::Done, "undo 应恢复目标原状态");
    }

    /// CP6：空选区与不存在的节点都要报错，不能生成脏剪贴板。
    #[test]
    fn c06_capture_rejects_empty_and_missing_ids() {
        let db = db();
        let root = create(&db, None, "R");
        assert!(matches!(
            capture(&db.conn, &[], "d", "文档"),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            capture(&db.conn, &["missing".to_string()], "d", "文档"),
            Err(AppError::NodeNotFound(_))
        ));
        assert!(capture(&db.conn, &[root], "d", "文档").is_ok());
    }

    /// CP7：Tauri 返回 / 参数走 camelCase，字段名写错前端会静默拿到 undefined。
    #[test]
    fn c07_ipc_dtos_serialize_camel_case() {
        let info = ClipboardInfo {
            node_count: 2,
            total_count: 5,
            summary: "A 等 2 项".to_string(),
            source_doc_id: "d1".to_string(),
            source_doc_name: "文档一".to_string(),
        };
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(v["nodeCount"], 2);
        assert_eq!(v["totalCount"], 5);
        assert_eq!(v["sourceDocName"], "文档一");
        assert!(v.get("node_count").is_none());

        let result = crate::model::PasteResult {
            new_ids: vec!["x".to_string()],
            affected: Affected {
                upserted: Vec::new(),
                removed: Vec::new(),
            },
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["newIds"], serde_json::json!(["x"]));
        assert!(v.get("upserted").is_some());
        assert!(v.get("removed").is_some());
        assert!(v.get("new_ids").is_none());
    }

    /// CP8：全 done 子树粘到 done 目标 → 目标保持 done（I4 例外后最关键的 I2 场景）。
    #[test]
    fn c08_paste_done_subtree_keeps_done_target() {
        let src = db();
        let src_root = create(&src, None, "源根");
        let a = create(&src, Some(&src_root), "A");
        let b = create(&src, Some(&a), "B");
        {
            let tx = src.conn.unchecked_transaction().unwrap();
            propagate::complete(&tx, &b).unwrap();
            tx.commit().unwrap();
        }
        let clip = capture(&src.conn, std::slice::from_ref(&a), "d", "源").unwrap();
        assert!(clip.nodes.iter().all(|n| n.status == NodeStatus::Done));

        let dst = db();
        let target = create(&dst, None, "目标根");
        {
            let tx = dst.conn.unchecked_transaction().unwrap();
            propagate::complete(&tx, &target).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(status(&dst, &target), NodeStatus::Done);

        let tx = dst.conn.unchecked_transaction().unwrap();
        let before = queries::ancestors(&tx, Some(&target)).unwrap();
        let base = queries::next_position(&tx, Some(&target)).unwrap();
        let (new_nodes, new_ids) = materialize(&clip, &target, base, TS);
        let mut history = history::History::new();
        let _after = history::run_with_history(&tx, before, &mut history, |tx| {
            for n in &new_nodes {
                queries::insert_node(tx, n)?;
            }
            queries::set_collapsed(tx, &target, false, TS)?;
            let mut upserted = new_nodes.clone();
            upserted.push(queries::get_node(tx, &target)?);
            upserted.append(&mut propagate::propagate_upward(tx, Some(&target))?);
            Ok(Affected {
                upserted,
                removed: Vec::new(),
            })
        })
        .unwrap();
        tx.commit().unwrap();

        assert_eq!(status(&dst, &target), NodeStatus::Done, "所有子 done → 目标保持 done");
        assert_eq!(status(&dst, &new_ids[0]), NodeStatus::Done);
        assert!(queries::get_node(&dst.conn, &new_ids[0])
            .unwrap()
            .completed_at
            .is_some());
        assert_eq!(queries::child_count(&dst.conn, &target).unwrap(), 1);
    }

    /// CP9：部分完成的子树整体复制后，内部状态分布与父子映射保持原样（I2 自洽）。
    #[test]
    fn c09_paste_mixed_subtree_preserves_internal_status() {
        let src = db();
        let root = create(&src, None, "R");
        let a = create(&src, Some(&root), "A");
        let b = create(&src, Some(&a), "B");
        let _c = create(&src, Some(&a), "C");
        {
            let tx = src.conn.unchecked_transaction().unwrap();
            propagate::complete(&tx, &b).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(status(&src, &a), NodeStatus::Pending, "A 仍有 pending 子 C");
        assert_eq!(status(&src, &b), NodeStatus::Done);

        let clip = capture(&src.conn, std::slice::from_ref(&a), "d", "源").unwrap();
        let (nodes, _) = materialize(&clip, "TARGET", 1024.0, TS);
        let get = |label: &str| nodes.iter().find(|n| n.content == label).unwrap();
        assert_eq!(get("A").status, NodeStatus::Pending);
        assert_eq!(get("B").status, NodeStatus::Done);
        assert_eq!(get("C").status, NodeStatus::Pending);
        assert!(get("B").completed_at.is_some());
        assert!(get("C").completed_at.is_none());
        assert_eq!(get("A").parent_id.as_deref(), Some("TARGET"));
        assert_eq!(get("B").parent_id.as_deref(), Some(get("A").id.as_str()));
        assert_eq!(get("C").parent_id.as_deref(), Some(get("A").id.as_str()));
    }
}

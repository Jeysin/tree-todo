//! 撤销/重做引擎（docs/05 M2：命令模式，快照式精确回放，上限 100 步）。
//!
//! 模型：每次变更记录 entry { before, after }：
//! - `before`：受影响集合操作前的完整快照（含将被删除的节点 + 完整祖先链）；
//! - `after`：操作后的变更（与 IPC 返回的 Affected 同语义）。
//!
//! - undo = upsert(before) + remove(after.upserted 中 before 不存在的节点)
//! - redo = upsert(after.upserted) + remove(after.removed)
//!
//! 由于 before/after 都是一致状态的完整受影响集合，回放后全树自动满足 I2，
//! **无需再次传播**——这是本方案正确的关键。

use std::collections::{HashMap, HashSet, VecDeque};

use rusqlite::Transaction;

use crate::db::queries;
use crate::error::AppResult;
use crate::model::{Affected, Node};

#[derive(Debug, Clone)]
pub struct HistoryEntry {
    pub before: Vec<Node>,
    pub after: Affected,
}

#[derive(Default)]
pub struct History {
    undo_stack: VecDeque<HistoryEntry>,
    redo_stack: VecDeque<HistoryEntry>,
}

const MAX_DEPTH: usize = 100;

impl History {
    pub fn new() -> Self {
        Self::default()
    }

    /// 新操作入栈，并使 redo 栈失效。
    pub fn push(&mut self, entry: HistoryEntry) {
        self.undo_stack.push_back(entry);
        if self.undo_stack.len() > MAX_DEPTH {
            self.undo_stack.pop_front();
        }
        self.redo_stack.clear();
    }

    pub fn undo(&mut self) -> Option<HistoryEntry> {
        let e = self.undo_stack.pop_back()?;
        self.redo_stack.push_back(e.clone());
        Some(e)
    }

    pub fn redo(&mut self) -> Option<HistoryEntry> {
        let e = self.redo_stack.pop_back()?;
        self.undo_stack.push_back(e.clone());
        Some(e)
    }

    /// 切换文档时清空历史（跨文档撤销无意义）。
    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }
}

/// undo 的 patch：恢复 before；并删除「操作中新建出来」的节点（after.upserted 里 before 不存在的 id）。
pub fn undo_patch(entry: &HistoryEntry) -> Affected {
    let before_ids: HashSet<&str> = entry.before.iter().map(|n| n.id.as_str()).collect();
    let removed = entry
        .after
        .upserted
        .iter()
        .filter(|n| !before_ids.contains(n.id.as_str()))
        .map(|n| n.id.clone())
        .collect();
    Affected {
        upserted: entry.before.clone(),
        removed,
    }
}

/// 应用 patch：先按父先子顺序 upsert（保证外键有效），再 delete。
pub fn apply_patch(tx: &Transaction, patch: &Affected) -> AppResult<()> {
    let mut nodes = patch.upserted.clone();
    sort_parents_first(&mut nodes);
    for n in &nodes {
        queries::upsert_node(tx, n)?;
    }
    for id in &patch.removed {
        queries::delete_node(tx, id)?;
    }
    Ok(())
}

/// 按深度升序（父先子）。不在集合内的 parent 视为已存在，深度记 0。
pub fn sort_parents_first(nodes: &mut [Node]) {
    let by_id: HashMap<String, Node> = nodes.iter().map(|n| (n.id.clone(), n.clone())).collect();
    fn depth(id: &str, by_id: &HashMap<String, Node>, memo: &mut HashMap<String, usize>) -> usize {
        if let Some(d) = memo.get(id) {
            return *d;
        }
        let d = match by_id.get(id).and_then(|n| n.parent_id.as_deref()) {
            Some(p) if by_id.contains_key(p) => depth(p, by_id, memo) + 1,
            _ => 0,
        };
        memo.insert(id.to_string(), d);
        d
    }
    let mut memo = HashMap::new();
    nodes.sort_by_key(|n| depth(&n.id, &by_id, &mut memo));
}

/// 统一执行入口：op 执行变更并返回 after，随后将 entry 入栈。
pub fn run_with_history<F>(
    tx: &Transaction,
    before: Vec<Node>,
    history: &mut History,
    op: F,
) -> AppResult<Affected>
where
    F: FnOnce(&Transaction) -> AppResult<Affected>,
{
    let after = op(tx)?;
    history.push(HistoryEntry {
        before,
        after: after.clone(),
    });
    Ok(after)
}

/// 执行撤销：返回前端可直接合并的 patch（无历史时返回 None）。
pub fn undo(tx: &Transaction, history: &mut History) -> AppResult<Option<Affected>> {
    let Some(entry) = history.undo() else {
        return Ok(None);
    };
    let patch = undo_patch(&entry);
    apply_patch(tx, &patch)?;
    Ok(Some(patch))
}

/// 执行重做。
pub fn redo(tx: &Transaction, history: &mut History) -> AppResult<Option<Affected>> {
    let Some(entry) = history.redo() else {
        return Ok(None);
    };
    let patch = entry.after.clone();
    apply_patch(tx, &patch)?;
    Ok(Some(patch))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::model::NodeStatus;
    use crate::propagate;

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn status(db: &Db, id: &str) -> NodeStatus {
        queries::get_node(&db.conn, id).unwrap().status
    }

    /// 辅助：带历史创建节点。
    fn create(db: &Db, h: &mut History, parent: Option<&str>, content: &str) -> String {
        let tx = db.conn.unchecked_transaction().unwrap();
        let before = queries::ancestors(&tx, parent).unwrap();
        let mut new_id = String::new();
        run_with_history(&tx, before, h, |tx| {
            let (id, mut upserted) = propagate::create_node(tx, parent, content).unwrap();
            new_id = id.clone();
            upserted.push(queries::get_node(tx, &id).unwrap());
            Ok(Affected {
                upserted,
                removed: vec![],
            })
        })
        .unwrap();
        tx.commit().unwrap();
        new_id
    }

    fn toggle(db: &Db, h: &mut History, id: &str) {
        let tx = db.conn.unchecked_transaction().unwrap();
        let node = queries::get_node(&tx, id).unwrap();
        let mut before = queries::subtree_nodes(&tx, id).unwrap();
        before.extend(queries::ancestors(&tx, node.parent_id.as_deref()).unwrap());
        run_with_history(&tx, before, h, |tx| {
            let upserted = match node.status {
                NodeStatus::Pending => propagate::complete(tx, id).unwrap(),
                NodeStatus::Done => propagate::uncomplete(tx, id).unwrap(),
            };
            Ok(Affected {
                upserted,
                removed: vec![],
            })
        })
        .unwrap();
        tx.commit().unwrap();
    }

    fn delete(db: &Db, h: &mut History, id: &str) {
        let tx = db.conn.unchecked_transaction().unwrap();
        let node = queries::get_node(&tx, id).unwrap();
        let mut before = queries::subtree_nodes(&tx, id).unwrap();
        before.extend(queries::ancestors(&tx, node.parent_id.as_deref()).unwrap());
        run_with_history(&tx, before, h, |tx| {
            let (removed, upserted) = propagate::delete_node(tx, id).unwrap();
            Ok(Affected { upserted, removed })
        })
        .unwrap();
        tx.commit().unwrap();
    }

    fn undo(db: &Db, h: &mut History) {
        let tx = db.conn.unchecked_transaction().unwrap();
        super::undo(&tx, h).unwrap();
        tx.commit().unwrap();
    }

    fn redo(db: &Db, h: &mut History) {
        let tx = db.conn.unchecked_transaction().unwrap();
        super::redo(&tx, h).unwrap();
        tx.commit().unwrap();
    }

    /// undo create：撤销创建应删除新节点并恢复祖先状态。
    #[test]
    fn h01_undo_create_removes_node_and_restores_parent() {
        let db = db();
        let mut h = History::new();
        let a = create(&db, &mut h, None, "A");
        toggle(&db, &mut h, &a); // A done
        assert_eq!(status(&db, &a), NodeStatus::Done);

        let b = create(&db, &mut h, Some(&a), "B"); // CC1：A 回退 pending
        assert_eq!(status(&db, &a), NodeStatus::Pending);

        undo(&db, &mut h);
        assert!(queries::get_node(&db.conn, &b).is_err(), "B 应被撤销删除");
        assert_eq!(status(&db, &a), NodeStatus::Done, "A 应恢复为 done");

        redo(&db, &mut h);
        assert!(queries::get_node(&db.conn, &b).is_ok(), "redo 应重建 B");
        assert_eq!(status(&db, &a), NodeStatus::Pending);
    }

    /// undo/redo toggle（含级联与祖先链的完整回放）。
    #[test]
    fn h02_undo_complete_restores_whole_subtree() {
        let db = db();
        let mut h = History::new();
        let a = create(&db, &mut h, None, "A");
        let b = create(&db, &mut h, Some(&a), "B");
        let c = create(&db, &mut h, Some(&b), "C");

        toggle(&db, &mut h, &b); // M2 级联：B、C done，A done
        assert_eq!(status(&db, &a), NodeStatus::Done);

        undo(&db, &mut h);
        for id in [&a, &b, &c] {
            assert_eq!(status(&db, id), NodeStatus::Pending, "撤销后整棵子树回退 pending");
        }

        redo(&db, &mut h);
        for id in [&a, &b, &c] {
            assert_eq!(status(&db, id), NodeStatus::Done, "redo 后全部恢复 done");
        }
    }

    /// undo delete：重建被删子树并恢复祖先状态。
    #[test]
    fn h03_undo_delete_rebuilds_subtree() {
        let db = db();
        let mut h = History::new();
        let a = create(&db, &mut h, None, "A");
        let b = create(&db, &mut h, Some(&a), "B");
        let c = create(&db, &mut h, Some(&b), "C");
        toggle(&db, &mut h, &c); // C done → B done → A done
        assert_eq!(status(&db, &a), NodeStatus::Done);

        delete(&db, &mut h, &b); // 级联删 B、C；A 叶子化保持 done
        assert!(queries::get_node(&db.conn, &b).is_err());
        assert!(queries::get_node(&db.conn, &c).is_err());

        undo(&db, &mut h);
        let b2 = queries::get_node(&db.conn, &b).expect("undo 应重建 B");
        assert_eq!(b2.parent_id.as_deref(), Some(a.as_str()));
        assert_eq!(status(&db, &b), NodeStatus::Done, "B 恢复删除前状态");
        assert_eq!(status(&db, &c), NodeStatus::Done, "C 一并重建");
        assert_eq!(status(&db, &a), NodeStatus::Done);

        redo(&db, &mut h);
        assert!(queries::get_node(&db.conn, &b).is_err());
        assert!(queries::get_node(&db.conn, &c).is_err());
    }

    /// 新操作清空 redo 栈。
    #[test]
    fn h04_new_operation_clears_redo_stack() {
        let db = db();
        let mut h = History::new();
        let a = create(&db, &mut h, None, "A");
        toggle(&db, &mut h, &a);
        undo(&db, &mut h);
        assert_eq!(status(&db, &a), NodeStatus::Pending);

        // 新操作后 redo 应失效
        let _b = create(&db, &mut h, Some(&a), "B");
        let tx = db.conn.unchecked_transaction().unwrap();
        let r = super::redo(&tx, &mut h).unwrap();
        tx.commit().unwrap();
        assert!(r.is_none(), "新操作后 redo 栈应为空");
    }

    /// 空历史上 undo/redo 返回 None。
    #[test]
    fn h05_empty_history_is_noop() {
        let db = db();
        let mut h = History::new();
        let tx = db.conn.unchecked_transaction().unwrap();
        assert!(super::undo(&tx, &mut h).unwrap().is_none());
        assert!(super::redo(&tx, &mut h).unwrap().is_none());
        tx.commit().unwrap();
    }
}

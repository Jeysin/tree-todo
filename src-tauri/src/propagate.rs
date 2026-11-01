//! 状态传播引擎（docs/02 §2 —— 本项目最核心的领域逻辑）。
//!
//! 红线（AGENTS.md）：
//! - 所有状态变更必须经本模块，且与操作本体在**同一个事务**内提交；
//! - 规则表 C1 / M1 / M2 / M3 / D1 与向上传播算法不得偏离；
//! - 本模块为纯领域逻辑，不依赖任何 Tauri 类型，可独立单元测试。

use chrono::Utc;
use rusqlite::{params, Transaction};

use crate::db::queries;
use crate::error::{AppError, AppResult};
use crate::model::{Node, NodeStatus};

fn now() -> String {
    Utc::now().to_rfc3339()
}

/// 创建节点（C1）：新节点永远 pending（I4）；若父节点原为 done，则父回退 pending（CC1）。
///
/// 返回 (新节点 id, 向上传播中被修改的祖先列表)。
pub fn create_node(
    tx: &Transaction,
    parent_id: Option<&str>,
    content: &str,
) -> AppResult<(String, Vec<Node>)> {
    let id = uuid::Uuid::new_v4().to_string();
    let position = queries::next_position(tx, parent_id)?;
    let ts = now();
    let node = Node {
        id: id.clone(),
        parent_id: parent_id.map(str::to_string),
        content: content.to_string(),
        note: String::new(),
        status: NodeStatus::Pending,
        position,
        collapsed: false,
        created_at: ts.clone(),
        updated_at: ts,
        deleted_at: None,
        completed_at: None,
    };
    queries::insert_node(tx, &node)?;
    let changed_ancestors = propagate_upward(tx, parent_id)?;
    Ok((id, changed_ancestors))
}

/// 完成节点（M1 叶子 / M2 非叶子）：自身与所有 pending 子孙 → done（级联），然后向上传播。
///
/// 返回受影响快照（自身 + 级联子孙 + 被修改的祖先）。
pub fn complete(tx: &Transaction, id: &str) -> AppResult<Vec<Node>> {
    let ts = now();
    cascade_set_status(tx, id, "done", &ts)?;
    // 确保自身最终为 done（幂等：即使自身原本就是 done）
    queries::update_status(tx, id, NodeStatus::Done, &ts)?;
    let parent = queries::get_node(tx, id)?.parent_id;
    let mut affected = queries::subtree_nodes(tx, id)?;
    affected.append(&mut propagate_upward(tx, parent.as_deref())?);
    Ok(affected)
}

/// 取消完成（M3）：自身与所有 done 子孙 → pending（整棵子树重开），然后向上传播。
pub fn uncomplete(tx: &Transaction, id: &str) -> AppResult<Vec<Node>> {
    let ts = now();
    cascade_set_status(tx, id, "pending", &ts)?;
    queries::update_status(tx, id, NodeStatus::Pending, &ts)?;
    let parent = queries::get_node(tx, id)?.parent_id;
    let mut affected = queries::subtree_nodes(tx, id)?;
    affected.append(&mut propagate_upward(tx, parent.as_deref())?);
    Ok(affected)
}

/// 删除节点（D1，v0.3 起为软删除进入回收站）：标记子树 deleted_at，返回被标记 id 列表。
pub fn delete_node(tx: &Transaction, id: &str) -> AppResult<(Vec<String>, Vec<Node>)> {
    let node = queries::get_node(tx, id)?;
    let removed = queries::soft_delete_subtree(tx, id, &now())?;
    let changed = propagate_upward(tx, node.parent_id.as_deref())?;
    Ok((removed, changed))
}

/// 向上传播（docs/02 §2.2）：沿父链重算聚合「所有子 done → done，否则 pending」。
///
/// - 剪枝：祖先聚合结果与现值相同即停止（其上必然也已一致）；
/// - 叶子化（CC4）：父节点子集合被删空时保持原状态，不参与聚合。
pub(crate) fn propagate_upward(tx: &Transaction, start: Option<&str>) -> AppResult<Vec<Node>> {
    let mut changed = Vec::new();
    let mut cur = start.map(str::to_string);
    while let Some(cid) = cur {
        let total = queries::child_count(tx, &cid)?;
        if total == 0 {
            break; // CC4：无子节点的父保持原状态
        }
        let pending = queries::pending_child_count(tx, &cid)?;
        let new_status = if pending == 0 {
            NodeStatus::Done
        } else {
            NodeStatus::Pending
        };
        let node = queries::get_node(tx, &cid)?;
        if node.status == new_status {
            break; // 剪枝：已收敛
        }
        let ts = now();
        queries::update_status(tx, &cid, new_status, &ts)?;
        changed.push(queries::get_node(tx, &cid)?);
        cur = node.parent_id;
    }
    Ok(changed)
}

/// 移动节点（MV1）：改 parent/position，防环（CC8），新旧两路向上传播。
///
/// - `position` 为 None 时追加到新父末尾（分数定位法）；
/// - 新父若处于折叠状态则自动展开（拖入的节点必须可见）；
/// - 返回受影响快照（被移动节点 + 两路被修改的祖先 + 新父）。
pub fn move_node(
    tx: &Transaction,
    id: &str,
    new_parent: Option<&str>,
    position: Option<f64>,
) -> AppResult<Vec<Node>> {
    let node = queries::get_node(tx, id)?;
    if let Some(np) = new_parent {
        if np == id {
            return Err(AppError::CyclicMove);
        }
        // CC8：新父不能位于被移动节点的子树内
        if queries::subtree_ids(tx, id)?.iter().any(|s| s == np) {
            return Err(AppError::CyclicMove);
        }
        let _ = queries::get_node(tx, np)?; // 新父必须存在
    }

    let ts = now();
    let pos = match position {
        Some(p) => p,
        None => queries::next_position(tx, new_parent)?,
    };
    queries::move_node(tx, id, new_parent, pos, &ts)?;

    // 新父折叠则展开（拖入立即可见）
    let mut affected = Vec::new();
    if let Some(np) = new_parent {
        queries::set_collapsed(tx, np, false, &ts)?;
        affected.push(queries::get_node(tx, np)?);
    }

    affected.push(queries::get_node(tx, id)?);
    affected.append(&mut propagate_upward(tx, node.parent_id.as_deref())?);
    affected.append(&mut propagate_upward(tx, new_parent)?);
    Ok(affected)
}

/// 导入后的状态校正（docs/02 §5）：后序遍历，非叶子状态以子节点聚合为准。
/// 返回被修正的节点列表。
pub fn recompute_subtree(tx: &Transaction, id: &str) -> AppResult<Vec<Node>> {
    let mut changed = Vec::new();
    for cid in queries::children_ids(tx, id)? {
        changed.append(&mut recompute_subtree(tx, &cid)?);
    }
    let total = queries::child_count(tx, id)?;
    if total > 0 {
        let pending = queries::pending_child_count(tx, id)?;
        let new_status = if pending == 0 {
            NodeStatus::Done
        } else {
            NodeStatus::Pending
        };
        let node = queries::get_node(tx, id)?;
        if node.status != new_status {
            queries::update_status(tx, id, new_status, &now())?;
            changed.push(queries::get_node(tx, id)?);
        }
    }
    Ok(changed)
}

/// 级联：子树（含自身）中所有 status != target 的未删节点 → target，并同步 completed_at。
fn cascade_set_status(tx: &Transaction, id: &str, target: &str, ts: &str) -> AppResult<()> {
    tx.execute(
        "WITH RECURSIVE subtree(sid) AS (
            SELECT id FROM nodes WHERE id = ?1
            UNION ALL
            SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.sid
        )
        UPDATE nodes SET status = ?2, updated_at = ?3,
            completed_at = CASE WHEN ?2 = 'done' THEN ?3 ELSE NULL END
        WHERE id IN (SELECT sid FROM subtree) AND status != ?2 AND deleted_at IS NULL",
        params![id, target, ts],
    )?;
    Ok(())
}

// ───────────────────────────── 单元测试 ─────────────────────────────
// 覆盖 docs/02 规则表（C1/M1/M2/M3/D1/E1）与 Corner Cases CC1–CC8 + 大子树冒烟。

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn db() -> Db {
        Db::open_in_memory().expect("内存库初始化失败")
    }

    fn create(db: &Db, parent: Option<&str>, content: &str) -> String {
        let tx = db.conn.unchecked_transaction().unwrap();
        let (id, _) = create_node(&tx, parent, content).unwrap();
        tx.commit().unwrap();
        id
    }

    fn status(db: &Db, id: &str) -> NodeStatus {
        queries::get_node(&db.conn, id).unwrap().status
    }

    fn complete(db: &Db, id: &str) {
        let tx = db.conn.unchecked_transaction().unwrap();
        super::complete(&tx, id).unwrap();
        tx.commit().unwrap();
    }

    fn uncomplete(db: &Db, id: &str) {
        let tx = db.conn.unchecked_transaction().unwrap();
        super::uncomplete(&tx, id).unwrap();
        tx.commit().unwrap();
    }

    fn delete(db: &Db, id: &str) -> Vec<String> {
        let tx = db.conn.unchecked_transaction().unwrap();
        let (removed, _) = delete_node(&tx, id).unwrap();
        tx.commit().unwrap();
        removed
    }

    /// 依次创建链：第一个挂在 parent 下，后续各挂前一个之下。
    fn chain(db: &Db, parent: Option<&str>, contents: &[&str]) -> Vec<String> {
        let mut ids = Vec::new();
        let mut cur = parent.map(str::to_string);
        for c in contents {
            let id = create(db, cur.as_deref(), c);
            cur = Some(id.clone());
            ids.push(id);
        }
        ids
    }

    /// I4 + C1：新建节点（根/子）默认 pending。
    #[test]
    fn t01_create_defaults_to_pending() {
        let db = db();
        let root = create(&db, None, "任务线 A");
        assert_eq!(status(&db, &root), NodeStatus::Pending);
        let child = create(&db, Some(&root), "子任务");
        assert_eq!(status(&db, &child), NodeStatus::Pending);
    }

    /// M1 + CC2：完成父下最后一个 pending 子节点 → 父自动 done，并继续向上。
    #[test]
    fn t02_cc2_all_children_done_parent_auto_done() {
        let db = db();
        let ids = chain(&db, None, &["A", "B", "C"]); // A→B→C
        let c = ids[2].clone();
        complete(&db, &c);
        assert_eq!(status(&db, &ids[2]), NodeStatus::Done);
        assert_eq!(status(&db, &ids[1]), NodeStatus::Done, "B 应自动完成");
        assert_eq!(status(&db, &ids[0]), NodeStatus::Done, "A 应自动完成");
    }

    /// CC1：在 done 父节点下新建子节点 → 父回退 pending，祖父链同理重算。
    #[test]
    fn t03_cc1_create_under_done_parent_reverts() {
        let db = db();
        let ids = chain(&db, None, &["A", "B"]); // A→B
        complete(&db, &ids[1]); // B done → A done
        assert_eq!(status(&db, &ids[0]), NodeStatus::Done);

        let new_child = create(&db, Some(&ids[0]), "新增事项");
        assert_eq!(status(&db, &new_child), NodeStatus::Pending);
        assert_eq!(status(&db, &ids[0]), NodeStatus::Pending, "CC1：父必须回退 pending");
        assert_eq!(status(&db, &ids[1]), NodeStatus::Done, "兄弟 B 保持 done");
    }

    /// M2：完成非叶子 → 级联完成所有 pending 子孙。
    #[test]
    fn t04_m2_complete_parent_cascades_descendants() {
        let db = db();
        let a = create(&db, None, "A");
        let b = create(&db, Some(&a), "B");
        let c1 = create(&db, Some(&b), "C1");
        let c2 = create(&db, Some(&b), "C2");
        let d = create(&db, Some(&c1), "D");
        complete(&db, &c2); // 部分完成，不影响断言主体
        assert_eq!(status(&db, &b), NodeStatus::Pending);

        complete(&db, &b); // M2：B 是非叶子
        for id in [&a, &b, &c1, &c2, &d] {
            assert_eq!(status(&db, id), NodeStatus::Done, "整棵子树应全部完成");
        }
    }

    /// CC3：取消已完成父节点 → 整棵子树回退 pending。
    #[test]
    fn t05_cc3_uncomplete_cascades_descendants() {
        let db = db();
        let a = create(&db, None, "A");
        let b = create(&db, Some(&a), "B");
        let c = create(&db, Some(&b), "C");
        let d = create(&db, Some(&c), "D");
        complete(&db, &b); // B、C、D 全 done，A done
        assert_eq!(status(&db, &a), NodeStatus::Done);

        uncomplete(&db, &b); // CC3
        for id in [&b, &c, &d] {
            assert_eq!(status(&db, id), NodeStatus::Pending, "子树应整体重开");
        }
        assert_eq!(status(&db, &a), NodeStatus::Pending, "A 因存在 pending 子节点回退");
    }

    /// CC7 + M1：兄弟节点部分完成，父保持 pending；取消完成单个叶子向上传播回退。
    #[test]
    fn t06_cc7_sibling_pending_parent_stays_pending() {
        let db = db();
        let p = create(&db, None, "P");
        let a = create(&db, Some(&p), "A");
        let b = create(&db, Some(&p), "B");
        complete(&db, &a);
        assert_eq!(status(&db, &p), NodeStatus::Pending, "CC7：B 未完成时 P 保持 pending");

        complete(&db, &b);
        assert_eq!(status(&db, &p), NodeStatus::Done);

        uncomplete(&db, &b);
        assert_eq!(status(&db, &p), NodeStatus::Pending);
        assert_eq!(status(&db, &a), NodeStatus::Done, "取消 B 不影响 A");
    }

    /// CC4：删除父节点下唯一子节点 → 父成为叶子并保持原状态。
    #[test]
    fn t07_cc4_delete_only_child_parent_keeps_status() {
        let db = db();
        let a = create(&db, None, "A");
        let b = create(&db, Some(&a), "B");
        complete(&db, &b);
        assert_eq!(status(&db, &a), NodeStatus::Done);

        delete(&db, &b);
        assert_eq!(status(&db, &a), NodeStatus::Done, "CC4：叶子化后保持原状态");
        assert_eq!(
            queries::child_count(&db.conn, &a).unwrap(),
            0,
            "A 应成为叶子"
        );
    }

    /// CC5：删除父节点下唯一的 pending 子节点 → 父自动 done。
    #[test]
    fn t08_cc5_delete_only_pending_child_parent_auto_done() {
        let db = db();
        let p = create(&db, None, "P");
        let done_child = create(&db, Some(&p), "已完成的子");
        let pending_child = create(&db, Some(&p), "待处理的子");
        let _ = done_child;
        complete(&db, &done_child);
        assert_eq!(status(&db, &p), NodeStatus::Pending);

        delete(&db, &pending_child);
        assert_eq!(status(&db, &p), NodeStatus::Done, "CC5：唯一 pending 子被删后父自动完成");
    }

    /// D1：删除节点级联删除子孙，且 removed 包含全部被删 id。
    #[test]
    fn t09_d1_delete_cascades_and_reports_removed() {
        let db = db();
        let a = create(&db, None, "A");
        let b = create(&db, Some(&a), "B");
        let c = create(&db, Some(&b), "C");
        let d = create(&db, Some(&a), "D");

        let removed = delete(&db, &b);
        assert_eq!(removed.len(), 2, "B 和 C 都应被级联删除");
        assert!(removed.contains(&b) && removed.contains(&c));
        for id in &removed {
            assert!(queries::get_node(&db.conn, id).is_err(), "已删除节点不可再查询");
        }
        assert!(queries::get_node(&db.conn, &d).is_ok(), "D 不受影响");
        assert_eq!(status(&db, &a), NodeStatus::Pending);
    }

    /// CC6：多根隔离——一条根任务线的完成不影响其他根。
    #[test]
    fn t10_cc6_roots_isolated() {
        let db = db();
        let r1 = create(&db, None, "任务线 1");
        let r2 = create(&db, None, "任务线 2");
        let c1 = create(&db, Some(&r1), "1 的子");
        let c2 = create(&db, Some(&r2), "2 的子");
        complete(&db, &c1);
        complete(&db, &c2);
        complete(&db, &r1);
        assert_eq!(status(&db, &r1), NodeStatus::Done);
        // r2 已随 c2 完成而自动 done；再验证：在 r1 下新建不影响 r2
        let _ = create(&db, Some(&r1), "1 的新子");
        let _ = c2;
        assert_eq!(status(&db, &r1), NodeStatus::Pending);
        assert_eq!(status(&db, &r2), NodeStatus::Done, "CC6：另一条根不受影响");
    }

    /// E1：编辑内容不触发任何状态变化。
    #[test]
    fn t11_e1_update_content_keeps_status() {
        let db = db();
        let a = create(&db, None, "A");
        let b = create(&db, Some(&a), "B");
        let tx = db.conn.unchecked_transaction().unwrap();
        queries::update_content(&tx, &b, "改名后的 B", &now()).unwrap();
        tx.commit().unwrap();
        assert_eq!(status(&db, &b), NodeStatus::Pending);
        assert_eq!(status(&db, &a), NodeStatus::Pending);
        assert_eq!(
            queries::get_node(&db.conn, &b).unwrap().content,
            "改名后的 B"
        );
    }

    /// 分数定位：同级位置按创建顺序递增。
    #[test]
    fn t12_sibling_positions_ordered() {
        let db = db();
        let a = create(&db, None, "A");
        let b = create(&db, None, "B");
        let c = create(&db, None, "C");
        let pa = queries::get_node(&db.conn, &a).unwrap().position;
        let pb = queries::get_node(&db.conn, &b).unwrap().position;
        let pc = queries::get_node(&db.conn, &c).unwrap().position;
        assert!(pa < pb && pb < pc, "同级 position 应递增：{pa} < {pb} < {pc}");
    }

    /// 大子树冒烟：2041 节点上级联完成 / 级联取消的耗时与正确性（docs/02 §2.5 性能要求）。
    #[test]
    fn t13_large_subtree_cascade_smoke() {
        let db = db();
        // 构造：1 根 + 40 子 + 40×50 孙 = 2041 节点
        let root = create(&db, None, "root");
        let mut leaf_ids = Vec::new();
        for i in 0..40 {
            let child = create(&db, Some(&root), &format!("c{i}"));
            for j in 0..50 {
                let leaf = create(&db, Some(&child), &format!("c{i}-{j}"));
                leaf_ids.push(leaf);
            }
        }
        assert_eq!(queries::all_nodes(&db.conn).unwrap().len(), 2041);

        let t0 = std::time::Instant::now();
        complete(&db, &root); // M2：级联完成 2001 节点
        let dur_complete = t0.elapsed();
        assert_eq!(status(&db, &root), NodeStatus::Done);
        assert_eq!(status(&db, &leaf_ids[1234]), NodeStatus::Done);

        let t1 = std::time::Instant::now();
        uncomplete(&db, &leaf_ids[1234]); // M3：单叶子重开 → 沿祖先链向上传播
        let dur_uncomplete = t1.elapsed();
        assert_eq!(status(&db, &leaf_ids[1234]), NodeStatus::Pending);
        assert_eq!(status(&db, &root), NodeStatus::Pending, "重开一个叶子 → 根回退 pending");

        // in-memory + 机械盘机器，宽限阈值防抖动
        assert!(dur_complete.as_secs_f64() < 5.0, "级联完成耗时异常: {dur_complete:?}");
        assert!(dur_uncomplete.as_secs_f64() < 1.0, "向上传播耗时异常: {dur_uncomplete:?}");
    }

    fn move_op(db: &Db, id: &str, parent: Option<&str>, position: Option<f64>) -> AppResult<Vec<Node>> {
        let tx = db.conn.unchecked_transaction().unwrap();
        let r = super::move_node(&tx, id, parent, position);
        if r.is_ok() {
            tx.commit().unwrap();
        }
        r
    }

    /// MV1：跨树移动后新旧两路传播正确；新父自动展开。
    #[test]
    fn t14_move_between_trees_propagates_both_paths() {
        let db = db();
        // 树 A：A→B（B done → A done）；树 C：C→D pending
        let a = create(&db, None, "A");
        let b = create(&db, Some(&a), "B");
        let c = create(&db, None, "C");
        let d = create(&db, Some(&c), "D");
        complete(&db, &b);
        assert_eq!(status(&db, &a), NodeStatus::Done);
        assert_eq!(status(&db, &c), NodeStatus::Pending);
        // C 折叠，验证移动后自动展开
        let tx = db.conn.unchecked_transaction().unwrap();
        queries::set_collapsed(&tx, &c, true, "now").unwrap();
        tx.commit().unwrap();

        // 把 B 从 A 移到 C 下
        move_op(&db, &b, Some(&c), None).unwrap();
        assert_eq!(
            queries::get_node(&db.conn, &b).unwrap().parent_id.as_deref(),
            Some(c.as_str())
        );
        assert_eq!(status(&db, &a), NodeStatus::Done, "A 叶子化保持原状态（CC4）");
        assert_eq!(status(&db, &c), NodeStatus::Pending, "C 有 pending 子 D 仍为 pending");
        assert!(!queries::get_node(&db.conn, &c).unwrap().collapsed, "新父应自动展开");

        // 再把 D 完成：C 的子为 B(done) + D(done) → C 自动 done
        complete(&db, &d);
        assert_eq!(status(&db, &c), NodeStatus::Done);
    }

    /// CC8：移动到自身子树内被拒绝。
    #[test]
    fn t15_move_cycle_rejected() {
        let db = db();
        let ids = chain(&db, None, &["A", "B", "C"]); // A→B→C
        let err = move_op(&db, &ids[0], Some(&ids[2]), None);
        assert!(matches!(err, Err(AppError::CyclicMove)), "应返回 CyclicMove: {err:?}");
        // 移动到自身也被拒绝
        let err2 = move_op(&db, &ids[1], Some(&ids[1]), None);
        assert!(matches!(err2, Err(AppError::CyclicMove)));
    }

    /// 移动到根 + 精确 position（分数定位）。
    #[test]
    fn t16_move_to_root_with_position() {
        let db = db();
        let a = create(&db, None, "A");
        let b = create(&db, Some(&a), "B");
        move_op(&db, &b, None, Some(5000.0)).unwrap();
        let n = queries::get_node(&db.conn, &b).unwrap();
        assert!(n.parent_id.is_none(), "B 应成为根节点");
        assert!((n.position - 5000.0).abs() < f64::EPSILON);
        assert_eq!(status(&db, &a), NodeStatus::Pending);
    }

    /// v0.3 软删除：删除进入回收站，视图不可见，父节点状态重算。
    #[test]
    fn t17_soft_delete_goes_to_trash() {
        let db = db();
        let p = create(&db, None, "P");
        let b = create(&db, Some(&p), "B");
        let c = create(&db, Some(&b), "C");
        complete(&db, &c); // C done → B done → P done
        assert_eq!(status(&db, &p), NodeStatus::Done);

        let removed = delete(&db, &b);
        assert_eq!(removed.len(), 2, "B、C 均被软删除");
        assert!(queries::get_node(&db.conn, &b).is_err(), "视图不可见");
        // 物理记录仍在回收站
        let trash = queries::trash_items(&db.conn).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].node.id, b);
        assert_eq!(trash[0].descendant_count, 1, "含 1 个被删子孙");
        // P 叶子化保持原状态（CC4）
        assert_eq!(status(&db, &p), NodeStatus::Done);
    }

    /// v0.3 恢复：子树回归视图，父节点向上传播。
    #[test]
    fn t18_restore_from_trash() {
        let db = db();
        let p = create(&db, None, "P");
        let b = create(&db, Some(&p), "B");
        let _c = create(&db, Some(&b), "C");
        delete(&db, &b);
        assert!(queries::get_node(&db.conn, &b).is_err());

        let tx = db.conn.unchecked_transaction().unwrap();
        let restored = queries::restore_subtree(&tx, &b, "now").unwrap();
        super::propagate_upward(&tx, Some(&p)).unwrap();
        tx.commit().unwrap();

        assert_eq!(restored.len(), 2, "B、C 均恢复");
        assert!(queries::get_node(&db.conn, &b).is_ok());
        assert!(queries::get_node(&db.conn, &p).is_ok());
        assert_eq!(status(&db, &p), NodeStatus::Pending, "恢复 pending 子节点后父回退");
        assert!(queries::trash_items(&db.conn).unwrap().is_empty());
    }

    /// v0.3 彻底删除：物理移除（含软删子孙）。
    #[test]
    fn t19_purge_removes_permanently() {
        let db = db();
        let a = create(&db, None, "A");
        let b = create(&db, Some(&a), "B");
        let _c = create(&db, Some(&b), "C");
        delete(&db, &b);
        assert_eq!(queries::trash_items(&db.conn).unwrap().len(), 1);

        // 物理删除（CASCADE 清理子孙）
        queries::delete_node(&db.conn, &b).unwrap();
        assert!(queries::get_node_any(&db.conn, &b).is_err());
        assert!(queries::get_node_any(&db.conn, &_c).is_err());
        assert!(queries::trash_items(&db.conn).unwrap().is_empty());
    }

    /// v0.3 completed_at：随 status 变更维护（统计面板数据来源）。
    #[test]
    fn t20_completed_at_tracks_status() {
        let db = db();
        let a = create(&db, None, "A");
        let b = create(&db, Some(&a), "B");
        assert!(queries::get_node(&db.conn, &b).unwrap().completed_at.is_none());

        complete(&db, &b); // 叶子完成
        let nb = queries::get_node(&db.conn, &b).unwrap();
        assert!(nb.completed_at.is_some(), "done 应有 completed_at");
        let na = queries::get_node(&db.conn, &a).unwrap();
        assert!(na.completed_at.is_some(), "自动完成的父节点也应有 completed_at");

        uncomplete(&db, &b);
        assert!(
            queries::get_node(&db.conn, &b).unwrap().completed_at.is_none(),
            "cancelled 应清除 completed_at"
        );
        assert!(queries::get_node(&db.conn, &a).unwrap().completed_at.is_none());
    }
}

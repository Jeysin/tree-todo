//! 状态传播引擎（docs/02 §2 —— 本项目最核心的领域逻辑）。
//!
//! 红线（AGENTS.md）：
//! - 所有状态变更必须经本模块，且与操作本体在**同一个事务**内提交；
//! - 规则表 C1 / M1 / M2 / M3 / D1 与向上传播算法不得偏离；
//! - 本模块为纯领域逻辑，不依赖任何 Tauri 类型，可独立单元测试。

use chrono::Utc;
use rusqlite::{params, Transaction};

use crate::db::queries;
use crate::error::AppResult;
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

/// 删除节点（D1）：级联删除子孙，返回 (被删 id 列表, 被传播修改的祖先列表)。
pub fn delete_node(tx: &Transaction, id: &str) -> AppResult<(Vec<String>, Vec<Node>)> {
    let node = queries::get_node(tx, id)?;
    let removed = queries::subtree_ids(tx, id)?;
    queries::delete_node(tx, id)?; // ON DELETE CASCADE 连带子孙
    let changed = propagate_upward(tx, node.parent_id.as_deref())?;
    Ok((removed, changed))
}

/// 向上传播（docs/02 §2.2）：沿父链重算聚合「所有子 done → done，否则 pending」。
///
/// - 剪枝：祖先聚合结果与现值相同即停止（其上必然也已一致）；
/// - 叶子化（CC4）：父节点子集合被删空时保持原状态，不参与聚合。
fn propagate_upward(tx: &Transaction, start: Option<&str>) -> AppResult<Vec<Node>> {
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

/// 级联：子树（含自身）中所有 status != target 的节点 → target。
fn cascade_set_status(tx: &Transaction, id: &str, target: &str, ts: &str) -> AppResult<()> {
    tx.execute(
        "WITH RECURSIVE subtree(sid) AS (
            SELECT id FROM nodes WHERE id = ?1
            UNION ALL
            SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.sid
        )
        UPDATE nodes SET status = ?2, updated_at = ?3
        WHERE id IN (SELECT sid FROM subtree) AND status != ?2",
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
}

//! 运行账本（docs/06 §7.2）：runs / run_nodes 的读写。
//! 与 nodes 同库，所有状态变更由命令层在同一事务内协调 exec::sync_run。

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use super::exec;
use crate::error::{AppError, AppResult};
use crate::model::{Run, RunNode, RunStatus, RunView};

const RUN_COLS: &str = "id, agent_id, agent_version, status, mode, needs_confirmation, workspace, model, effort, \
     prompt, session_id, pid, exit_code, started_at, finished_at, duration_ms, cost_usd, tokens_in, tokens_out, \
     summary, error, reviewed_at, dismissed_at, log_path";

fn row_to_run(row: &rusqlite::Row) -> rusqlite::Result<Run> {
    Ok(Run {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        agent_version: row.get(2)?,
        status: RunStatus::parse(&row.get::<_, String>(3)?),
        mode: row.get(4)?,
        needs_confirmation: row.get::<_, i64>(5)? != 0,
        workspace: row.get(6)?,
        model: row.get(7)?,
        effort: row.get(8)?,
        prompt: row.get(9)?,
        session_id: row.get(10)?,
        pid: row.get(11)?,
        exit_code: row.get(12)?,
        started_at: row.get(13)?,
        finished_at: row.get(14)?,
        duration_ms: row.get(15)?,
        cost_usd: row.get(16)?,
        tokens_in: row.get(17)?,
        tokens_out: row.get(18)?,
        summary: row.get(19)?,
        error: row.get(20)?,
        reviewed_at: row.get(21)?,
        dismissed_at: row.get(22)?,
        log_path: row.get(23)?,
    })
}

pub fn insert_run(tx: &Transaction<'_>, run: &Run, node_ids: &[String]) -> AppResult<()> {
    tx.execute(
        "INSERT INTO runs (id, agent_id, agent_version, status, mode, needs_confirmation, workspace, model, effort,
                           prompt, session_id, pid, exit_code, started_at, finished_at, duration_ms, cost_usd,
                           tokens_in, tokens_out, summary, error, reviewed_at, dismissed_at, log_path)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)",
        params![
            run.id,
            run.agent_id,
            run.agent_version,
            run.status.as_str(),
            run.mode,
            run.needs_confirmation as i64,
            run.workspace,
            run.model,
            run.effort,
            run.prompt,
            run.session_id,
            run.pid,
            run.exit_code,
            run.started_at,
            run.finished_at,
            run.duration_ms,
            run.cost_usd,
            run.tokens_in,
            run.tokens_out,
            run.summary,
            run.error,
            run.reviewed_at,
            run.dismissed_at,
            run.log_path,
        ],
    )?;
    for node_id in node_ids {
        tx.execute(
            "INSERT OR IGNORE INTO run_nodes (run_id, node_id, report, review) VALUES (?1, ?2, 'pending', 'pending')",
            params![run.id, node_id],
        )?;
    }
    Ok(())
}

pub fn get_run(conn: &Connection, id: &str) -> AppResult<Run> {
    conn.query_row(
        &format!("SELECT {RUN_COLS} FROM runs WHERE id = ?1"),
        params![id],
        row_to_run,
    )
    .optional()?
    .ok_or_else(|| AppError::RunNotFound(id.to_string()))
}

/// 构造一条「带回执复制」的 dispatched run（docs/06 v2 §6.1）。
///
/// 复制时只建账本、不碰节点（D29）；Agent 调 MCP start 才推进到 running。
pub fn new_dispatched_run(run_id: &str, prompt: &str, mode: &str) -> Run {
    Run {
        id: run_id.to_string(),
        // agent 在 start 时由 Agent 上报（D30），此前占位 pending。
        agent_id: "pending".into(),
        agent_version: None,
        status: RunStatus::Dispatched,
        mode: mode.to_string(),
        needs_confirmation: false,
        workspace: None,
        model: None,
        effort: None,
        prompt: prompt.to_string(),
        session_id: None,
        pid: None,
        exit_code: None,
        started_at: chrono::Utc::now().to_rfc3339(),
        finished_at: None,
        duration_ms: None,
        cost_usd: None,
        tokens_in: None,
        tokens_out: None,
        summary: None,
        error: None,
        reviewed_at: None,
        dismissed_at: None,
        log_path: None,
    }
}

/// 复制幂等（D31）：节点集合完全一致、且仍可接手的 run 直接复用。
///
/// 只认两种状态：
/// - `dispatched`：还没被 Agent 接手，复用后刷新 prompt 与 `started_at`（24h 过期计时重来）；
/// - `running`：Agent 正在做，复用后**只**刷新 prompt —— 不能碰 `started_at`（等于重置计时），
///   更不能收口（等于把「执行中」徽标连同执行态一起清掉）。
///
/// `awaiting_review` 故意不在此列：它的回执已定稿，再复制意味着重做，必须换一个新 run；
/// 复用会让 Agent 的 `start` 被「等待验收」拒绝、`complete` 被当已收口，直接卡死。
pub fn find_reusable_by_nodes(conn: &Connection, node_ids: &[String]) -> AppResult<Option<Run>> {
    if node_ids.is_empty() {
        return Ok(None);
    }
    let placeholders = node_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT r.id FROM runs r
         WHERE r.status IN ('dispatched','running')
           AND (SELECT COUNT(*) FROM run_nodes rn WHERE rn.run_id = r.id) = {n}
           AND {n} = (SELECT COUNT(*) FROM run_nodes rn WHERE rn.run_id = r.id AND rn.node_id IN ({placeholders}))
         ORDER BY CASE r.status WHEN 'running' THEN 0 ELSE 1 END, r.started_at DESC LIMIT 1",
        n = node_ids.len(),
    );
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::new();
    for id in node_ids {
        params.push(id);
    }
    let id: Option<String> = conn
        .query_row(&sql, params.as_slice(), |r| r.get(0))
        .optional()?;
    match id {
        Some(id) => Ok(Some(get_run(conn, &id)?)),
        None => Ok(None),
    }
}

/// 把指定节点名下**空闲**的活跃 run 收口为 cancelled·superseded（D31：新一轮复制替代旧轮）。
///
/// `running` 一律不动：复制 Prompt 是轻动作，不能打断正在进行的执行。
/// 只收口 `dispatched`（无人接手、无投影）、`queued`（历史值）与 `awaiting_review`
/// （回执已定稿，被新一轮替代）。
/// `except_run` 里的 run 不动（复用场景）。
pub fn supersede_idle_runs(
    tx: &Transaction<'_>,
    node_ids: &[String],
    except_run: Option<&str>,
) -> AppResult<Vec<String>> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut superseded = Vec::new();
    for node_id in node_ids {
        let ids: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT DISTINCT r.id FROM runs r JOIN run_nodes rn ON rn.run_id = r.id
                 WHERE rn.node_id = ?1 AND r.status IN ('dispatched','queued','awaiting_review')",
            )?;
            let rows = stmt.query_map(params![node_id], |r| r.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for run_id in ids {
            if Some(run_id.as_str()) == except_run {
                continue;
            }
            tx.execute(
                "UPDATE runs SET status = 'cancelled', summary = 'superseded',
                    finished_at = COALESCE(finished_at, ?2), error = NULL
                 WHERE id = ?1 AND status IN ('dispatched','queued','awaiting_review')",
                params![run_id, now],
            )?;
            // 被替代节点的待验收投影要清掉；只清「确实属于这个 run」的投影，
            // 避免顺手把同一节点上另一个 running run 的徽标一起抹掉。
            exec::sync_run(tx, &run_id)?;
            superseded.push(run_id);
        }
    }
    Ok(superseded)
}

/// 24h 过期收口（D32）：dispatched 超过 cutoff 的 run → cancelled·expired。
/// dispatched 无节点投影，收口无需 sync_run。
pub fn expire_dispatched(conn: &Connection, before: &str) -> AppResult<u64> {
    let now = chrono::Utc::now().to_rfc3339();
    let n = conn.execute(
        "UPDATE runs SET status = 'cancelled', summary = 'expired',
            finished_at = COALESCE(finished_at, ?2)
         WHERE status = 'dispatched' AND started_at < ?1",
        params![before, now],
    )?;
    Ok(n as u64)
}

/// 运行收口时的状态变更。
///
/// 用结构体而不是一串位置参数 —— 参数太多时容易把 `exit_code` 和 `duration_ms` 传错位置，
/// 而这里每个字段都影响最终显示。
#[derive(Debug, Default, Clone)]
pub struct StatusUpdate<'a> {
    pub status: RunStatus,
    pub exit_code: Option<i64>,
    pub error: Option<&'a str>,
    pub needs_confirmation: bool,
    pub finished_at: Option<&'a str>,
    pub duration_ms: Option<i64>,
}

pub fn set_status(
    tx: &Transaction<'_>,
    id: &str,
    update: StatusUpdate<'_>,
) -> AppResult<()> {
    tx.execute(
        "UPDATE runs SET status = ?2, exit_code = ?3, error = ?4, needs_confirmation = ?5,
                        finished_at = COALESCE(?6, finished_at), duration_ms = COALESCE(?7, duration_ms)
         WHERE id = ?1",
        params![
            id,
            update.status.as_str(),
            update.exit_code,
            update.error,
            update.needs_confirmation as i64,
            update.finished_at,
            update.duration_ms
        ],
    )?;
    Ok(())
}

pub fn list_runs(conn: &Connection, limit: usize) -> AppResult<Vec<Run>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLS} FROM runs ORDER BY started_at DESC LIMIT ?1"
    ))?;
    let rows = stmt.query_map(params![limit as i64], row_to_run)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn run_nodes(conn: &Connection, run_id: &str) -> AppResult<Vec<RunNode>> {
    let mut stmt = conn.prepare(
        "SELECT rn.run_id, rn.node_id, rn.report, rn.review, rn.reported_at, rn.reviewed_at, rn.summary,
                COALESCE(n.content, '')
         FROM run_nodes rn LEFT JOIN nodes n ON n.id = rn.node_id
         WHERE rn.run_id = ?1
         ORDER BY rn.rowid",
    )?;
    let rows = stmt.query_map(params![run_id], |row| {
        Ok(RunNode {
            run_id: row.get(0)?,
            node_id: row.get(1)?,
            report: row.get(2)?,
            review: row.get(3)?,
            reported_at: row.get(4)?,
            reviewed_at: row.get(5)?,
            summary: row.get(6)?,
            content: row.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get_run_view(conn: &Connection, id: &str) -> AppResult<RunView> {
    let run = get_run(conn, id)?;
    let nodes = run_nodes(conn, id)?;
    Ok(RunView { run, nodes })
}

pub fn update_report(
    tx: &Transaction<'_>,
    run_id: &str,
    items: &[(String, String, Option<String>)],
) -> AppResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    for (node_id, result, summary) in items {
        let n = tx.execute(
            "UPDATE run_nodes SET report = ?3, reported_at = ?4, summary = COALESCE(?5, summary)
             WHERE run_id = ?1 AND node_id = ?2",
            params![run_id, node_id, result, now, summary],
        )?;
        if n == 0 {
            // 不是本 run 的节点：忽略，避免 Agent 乱写。
            eprintln!("receipt ignored: run {run_id} has no node {node_id}");
        }
    }
    Ok(())
}

pub fn set_review(
    tx: &Transaction<'_>,
    run_id: &str,
    node_ids: &[String],
    review: &str,
) -> AppResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    for node_id in node_ids {
        tx.execute(
            "UPDATE run_nodes SET review = ?3, reviewed_at = ?4 WHERE run_id = ?1 AND node_id = ?2",
            params![run_id, node_id, review, now],
        )?;
    }
    Ok(())
}

/// 所有 run_nodes 都处理完（非 pending）→ run 收口为 reviewed。
pub fn maybe_mark_reviewed(tx: &Transaction<'_>, run_id: &str) -> AppResult<()> {
    let pending: i64 = tx.query_row(
        "SELECT COUNT(*) FROM run_nodes WHERE run_id = ?1 AND review = 'pending'",
        params![run_id],
        |r| r.get(0),
    )?;
    if pending == 0 {
        tx.execute(
            "UPDATE runs SET status = 'reviewed', reviewed_at = COALESCE(reviewed_at, ?2) WHERE id = ?1",
            params![run_id, chrono::Utc::now().to_rfc3339()],
        )?;
    }
    Ok(())
}

/// 清理 N 天前的已收口运行记录（跳过仍被节点引用的、跳过待验收的）。
pub fn purge_old(conn: &Connection, before_days: i64) -> AppResult<u64> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(before_days)).to_rfc3339();
    let n = conn.execute(
        "DELETE FROM runs
         WHERE started_at < ?1
           AND status IN ('reviewed','failed','cancelled','interrupted','blocked')
           AND id NOT IN (SELECT DISTINCT exec_run_id FROM nodes WHERE exec_run_id IS NOT NULL)",
        params![cutoff],
    )?;
    Ok(n as u64)
}

/// 清空全部已收口的运行记录（设置页「清空执行历史」）。
/// 待验收的记录一律保留 —— 它们还需要用户裁决。
pub fn purge_all_closed(conn: &Connection) -> AppResult<u64> {
    let n = conn.execute(
        "DELETE FROM runs
         WHERE status IN ('reviewed','failed','cancelled','interrupted','blocked')
           AND id NOT IN (SELECT DISTINCT exec_run_id FROM nodes WHERE exec_run_id IS NOT NULL)",
        [],
    )?;
    Ok(n as u64)
}

/// 当前文档里未收口的运行（顶部「运行中 N」徽标）。
pub fn active_runs(conn: &Connection) -> AppResult<Vec<Run>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLS} FROM runs WHERE status IN ('queued','running','awaiting_review')
         ORDER BY started_at DESC"
    ))?;
    let rows = stmt.query_map([], row_to_run)?;
    let mut out = Vec::new();
    for row in rows {
        let run = row?;
        if run.status.is_active() {
            out.push(run);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{exec, queries, Db};
    use crate::model::{ExecState, NodeStatus};

    fn seed(db: &mut Db) -> String {
        let tx = db.conn.transaction().unwrap();
        let (root, _) = crate::propagate::create_node_at(&tx, None, "任务线", None).unwrap();
        let (child, _) =
            crate::propagate::create_node_at(&tx, Some(&root), "做一件小事", None).unwrap();
        tx.commit().unwrap();
        child
    }

    #[test]
    fn receipt_only_sets_awaiting_review_and_accept_completes() {
        let mut db = Db::open_in_memory().unwrap();
        let node_id = seed(&mut db);
        let run = new_dispatched_run("run_test", "prompt", "copy");

        let tx = db.conn.transaction().unwrap();
        insert_run(&tx, &run, std::slice::from_ref(&node_id)).unwrap();
        exec::sync_run(&tx, "run_test").unwrap();
        tx.commit().unwrap();

        // dispatched 无投影（D29）：复制不改变节点。
        let n = queries::get_node(&db.conn, &node_id).unwrap();
        assert_eq!(n.status, NodeStatus::Pending);
        assert!(n.execution.is_none(), "dispatched 不得写节点投影");

        // start：running + 计时起点（agent 名此时落库）。
        let tx = db.conn.transaction().unwrap();
        tx.execute(
            "UPDATE runs SET status = 'running', agent_id = 'Trae' WHERE id = 'run_test'",
            [],
        )
        .unwrap();
        exec::sync_run(&tx, "run_test").unwrap();
        tx.commit().unwrap();
        let n = queries::get_node(&db.conn, &node_id).unwrap();
        assert_eq!(n.status, NodeStatus::Pending);
        assert_eq!(n.execution.as_ref().unwrap().state, ExecState::Running);
        assert_eq!(n.execution.as_ref().unwrap().agent_name, "Trae");

        // 回执：只写 run_nodes + exec，不改主状态
        let tx = db.conn.transaction().unwrap();
        update_report(&tx, "run_test", &[(node_id.clone(), "done".into(), Some("ok".into()))]).unwrap();
        set_status(
            &tx,
            "run_test",
            StatusUpdate {
                status: RunStatus::AwaitingReview,
                exit_code: None,
                error: None,
                needs_confirmation: false,
                finished_at: Some("2026-11-03T10:00:00Z"),
                duration_ms: Some(1000),
            },
        )
        .unwrap();
        exec::sync_run(&tx, "run_test").unwrap();
        tx.commit().unwrap();

        let n = queries::get_node(&db.conn, &node_id).unwrap();
        assert_eq!(n.status, NodeStatus::Pending, "回执绝不能写主状态");
        let exec_state = n.execution.as_ref().unwrap().state;
        assert_eq!(exec_state, ExecState::AwaitingReview);

        // 验收：accepted + clear + propagate::complete
        let tx = db.conn.transaction().unwrap();
        set_review(&tx, "run_test", std::slice::from_ref(&node_id), "accepted").unwrap();
        exec::clear_node(&tx, &node_id).unwrap();
        crate::propagate::complete(&tx, &node_id).unwrap();
        maybe_mark_reviewed(&tx, "run_test").unwrap();
        exec::sync_run(&tx, "run_test").unwrap();
        tx.commit().unwrap();

        let n = queries::get_node(&db.conn, &node_id).unwrap();
        assert_eq!(n.status, NodeStatus::Done);
        assert!(n.execution.is_none());
        assert_eq!(get_run(&db.conn, "run_test").unwrap().status, RunStatus::Reviewed);
    }

    #[test]
    fn copy_reuses_dispatched_and_running_but_never_touches_inflight() {
        let mut db = Db::open_in_memory().unwrap();
        let node_id = seed(&mut db);

        // 第一次复制 → dispatched run
        let run = new_dispatched_run("run_a", "prompt", "copy");
        let tx = db.conn.transaction().unwrap();
        insert_run(&tx, &run, std::slice::from_ref(&node_id)).unwrap();
        tx.commit().unwrap();

        // 同节点集合再复制 → 复用（D31）
        assert_eq!(
            find_reusable_by_nodes(&db.conn, std::slice::from_ref(&node_id))
                .unwrap()
                .map(|r| r.id),
            Some("run_a".into())
        );

        // Agent start 后节点挂 running → 仍可复用，且不再被收口
        let tx = db.conn.transaction().unwrap();
        tx.execute("UPDATE runs SET status = 'running' WHERE id = 'run_a'", []).unwrap();
        exec::sync_run(&tx, "run_a").unwrap();
        tx.commit().unwrap();

        let reusable = find_reusable_by_nodes(&db.conn, std::slice::from_ref(&node_id))
            .unwrap()
            .expect("running 的 run 可复用");
        assert_eq!(reusable.status, RunStatus::Running);

        let tx = db.conn.transaction().unwrap();
        let superseded = supersede_idle_runs(&tx, std::slice::from_ref(&node_id), None).unwrap();
        tx.commit().unwrap();
        assert!(superseded.is_empty(), "执行中的 run 不得被复制收口");
        assert_eq!(get_run(&db.conn, "run_a").unwrap().status, RunStatus::Running);
        let exec_now = queries::get_node(&db.conn, &node_id).unwrap().execution;
        assert_eq!(
            exec_now.map(|e| e.state),
            Some(ExecState::Running),
            "执行态与计时不得被复制清空"
        );
    }

    #[test]
    fn awaiting_review_is_superseded_and_cleared() {
        let mut db = Db::open_in_memory().unwrap();
        let node_id = seed(&mut db);
        let run = new_dispatched_run("run_r", "prompt", "copy");
        let tx = db.conn.transaction().unwrap();
        insert_run(&tx, &run, std::slice::from_ref(&node_id)).unwrap();
        tx.execute("UPDATE runs SET status = 'awaiting_review' WHERE id = 'run_r'", []).unwrap();
        exec::sync_run(&tx, "run_r").unwrap();
        tx.commit().unwrap();
        assert_eq!(
            queries::get_node(&db.conn, &node_id).unwrap().execution.map(|e| e.state),
            Some(ExecState::AwaitingReview)
        );

        // 回执已定稿 → 不复用（复用会让 Agent 的 start / complete 全被拒）
        assert!(
            find_reusable_by_nodes(&db.conn, std::slice::from_ref(&node_id)).unwrap().is_none(),
            "awaiting_review 不可复用"
        );

        // 重新复制 = 重做：旧轮收口，投影清空
        let tx = db.conn.transaction().unwrap();
        let superseded = supersede_idle_runs(&tx, std::slice::from_ref(&node_id), None).unwrap();
        tx.commit().unwrap();
        assert_eq!(superseded, vec!["run_r".to_string()]);
        assert_eq!(get_run(&db.conn, "run_r").unwrap().status, RunStatus::Cancelled);
        assert!(queries::get_node(&db.conn, &node_id).unwrap().execution.is_none());
    }

    #[test]
    fn superseding_one_run_keeps_another_runs_projection() {
        let mut db = Db::open_in_memory().unwrap();
        let node_id = seed(&mut db);
        // 旧轮：待验收；新轮：执行中（同一节点被两个 run 覆盖）
        for id in ["run_old", "run_new"] {
            let run = new_dispatched_run(id, "prompt", "copy");
            let tx = db.conn.transaction().unwrap();
            insert_run(&tx, &run, std::slice::from_ref(&node_id)).unwrap();
            tx.commit().unwrap();
        }
        let tx = db.conn.transaction().unwrap();
        tx.execute("UPDATE runs SET status = 'awaiting_review' WHERE id = 'run_old'", []).unwrap();
        exec::sync_run(&tx, "run_old").unwrap();
        tx.execute("UPDATE runs SET status = 'running' WHERE id = 'run_new'", []).unwrap();
        exec::sync_run(&tx, "run_new").unwrap();
        tx.commit().unwrap();

        // 收口旧轮：只能清自己的投影，不能把新轮的「执行中」一起抹掉
        let tx = db.conn.transaction().unwrap();
        supersede_idle_runs(&tx, std::slice::from_ref(&node_id), None).unwrap();
        tx.commit().unwrap();
        let exec_now = queries::get_node(&db.conn, &node_id).unwrap().execution;
        let exec_now = exec_now.expect("新轮的执行态必须保留");
        assert_eq!(exec_now.state, ExecState::Running);
        assert_eq!(exec_now.run_id.as_deref(), Some("run_new"));
    }

    #[test]
    fn expire_dispatched_only_touches_stale() {
        let mut db = Db::open_in_memory().unwrap();
        let node_id = seed(&mut db);
        for (id, stale) in [("run_old", true), ("run_new", false)] {
            let mut run = new_dispatched_run(id, "prompt", "copy");
            if stale {
                run.started_at = "2020-01-01T00:00:00Z".into();
            }
            let tx = db.conn.transaction().unwrap();
            insert_run(&tx, &run, std::slice::from_ref(&node_id)).unwrap();
            tx.commit().unwrap();
        }
        let cutoff = "2021-01-01T00:00:00Z";
        assert_eq!(expire_dispatched(&db.conn, cutoff).unwrap(), 1);
        assert_eq!(get_run(&db.conn, "run_old").unwrap().status, RunStatus::Cancelled);
        assert_eq!(get_run(&db.conn, "run_new").unwrap().status, RunStatus::Dispatched);
    }
}

//! 执行状态的物化投影（docs/06 §7.3）。
//! 唯一写入口：所有 run 状态变化都必须调用 sync_run，保证 nodes.exec_* 与 runs 一致。

use rusqlite::{params, Connection, Transaction};

use crate::error::AppResult;
use crate::model::{ExecDetail, ExecState, NodeExecution, RunStatus};

fn clear(conn: &Connection, node_id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE nodes SET exec_state = 'none', exec_run_id = NULL, exec_agent_id = NULL,
            exec_agent_name = NULL, exec_started_at = NULL, exec_finished_at = NULL,
            exec_duration_ms = NULL, exec_needs_confirm = 0, exec_detail = NULL
         WHERE id = ?1",
        params![node_id],
    )?;
    Ok(())
}

/// 只清空「确实挂在这个 run 上」的投影。
///
/// 同一节点可能同时被多个 run 覆盖（例如旧 run 还在等验收、新 run 已经跑起来）：
/// 收口其中一个 run 时，不能把另一个 run 刚刚写入的执行中 / 待验收徽标一起抹掉。
fn clear_owned(conn: &Connection, node_id: &str, run_id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE nodes SET exec_state = 'none', exec_run_id = NULL, exec_agent_id = NULL,
            exec_agent_name = NULL, exec_started_at = NULL, exec_finished_at = NULL,
            exec_duration_ms = NULL, exec_needs_confirm = 0, exec_detail = NULL
         WHERE id = ?1 AND exec_run_id = ?2",
        params![node_id, run_id],
    )?;
    Ok(())
}

fn write(conn: &Connection, node_id: &str, run_id: &str, exec: &NodeExecution) -> AppResult<()> {
    let detail = serde_json::to_string(&exec.detail).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "UPDATE nodes SET exec_state = ?2, exec_run_id = ?3, exec_agent_id = ?4,
            exec_agent_name = ?5, exec_started_at = ?6, exec_finished_at = ?7,
            exec_duration_ms = ?8, exec_needs_confirm = ?9, exec_detail = ?10
         WHERE id = ?1",
        params![
            node_id,
            exec.state.as_str(),
            run_id,
            exec.agent_id,
            exec.agent_name,
            exec.started_at,
            exec.finished_at,
            exec.duration_ms,
            exec.needs_confirmation as i64,
            detail
        ],
    )?;
    Ok(())
}

/// 按 run 当前状态重写它名下所有节点的 exec_*。
pub fn sync_run(tx: &Transaction<'_>, run_id: &str) -> AppResult<()> {
    let run = super::runs::get_run(tx, run_id)?;
    let nodes = super::runs::run_nodes(tx, run_id)?;
    let finished = run.finished_at.clone();
    let duration = run.duration_ms;
    for rn in nodes {
        if rn.review != "pending" || matches!(run.status, RunStatus::Reviewed | RunStatus::Cancelled) {
            clear_owned(tx, &rn.node_id, run_id)?;
            continue;
        }
        let state = match run.status {
            // dispatched 无投影（D29）：复制是轻动作，Agent 调 start 才亮灯。
            RunStatus::Dispatched | RunStatus::Reviewed | RunStatus::Cancelled => ExecState::None,
            // queued 是 push 时代的历史值，仅兼容旧数据。
            RunStatus::Queued => ExecState::Queued,
            RunStatus::Running => ExecState::Running,
            RunStatus::AwaitingReview => ExecState::AwaitingReview,
            RunStatus::Failed | RunStatus::Blocked | RunStatus::Interrupted => ExecState::Failed,
        };
        if state == ExecState::None {
            clear_owned(tx, &rn.node_id, run_id)?;
            continue;
        }
        let reported = if rn.report == "pending" {
            None
        } else {
            Some(rn.report.clone())
        };
        let exec = NodeExecution {
            state,
            run_id: Some(run_id.to_string()),
            agent_id: run.agent_id.clone(),
            agent_name: run.agent_id.clone(),
            started_at: run.started_at.clone(),
            finished_at: finished.clone(),
            duration_ms: duration,
            // needs_confirmation 的原语义（退出码 0 但无回执）随进程一起消失；
            // 只在待验收且 run 上有历史标记时保留提示。
            needs_confirmation: run.needs_confirmation && run.status == RunStatus::AwaitingReview,
            detail: ExecDetail {
                model: run.model.clone(),
                workspace: run.workspace.clone(),
                reported,
                summary: rn.summary.clone().or(run.summary.clone()),
                source: Some("run".into()),
            },
        };
        write(tx, &rn.node_id, run_id, &exec)?;
    }
    Ok(())
}

/// 清空单个节点的执行态（验收 / 驳回 / 忽略）。
pub fn clear_node(conn: &Connection, node_id: &str) -> AppResult<()> {
    clear(conn, node_id)
}

/// 导入带来的执行态（无 run）：写列，source=import。
pub fn apply_imported(tx: &Transaction<'_>, node_id: &str, exec: &NodeExecution) -> AppResult<()> {
    if exec.state == ExecState::None {
        return clear(tx, node_id);
    }
    write(tx, node_id, "", exec)
}

/// 启动 / 切换文档时校正：exec_run_id 指向不存在或已收口的 run → 清空。
pub fn reconcile(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "UPDATE nodes SET exec_state = 'none', exec_run_id = NULL, exec_agent_id = NULL,
            exec_agent_name = NULL, exec_started_at = NULL, exec_finished_at = NULL,
            exec_duration_ms = NULL, exec_needs_confirm = 0, exec_detail = NULL
         WHERE exec_state != 'none'
           AND (exec_run_id IS NULL
                OR exec_run_id NOT IN (SELECT id FROM runs)
                OR exec_run_id IN (SELECT id FROM runs WHERE status IN ('reviewed','cancelled')))",
        [],
    )?;
    Ok(())
}

/// 当前文档里活跃执行计数（前端徽标/状态栏用）。
pub fn counts(conn: &Connection) -> AppResult<(i64, i64, i64)> {
    let mut stmt = conn.prepare(
        "SELECT
            SUM(CASE WHEN exec_state IN ('queued','running') THEN 1 ELSE 0 END),
            SUM(CASE WHEN exec_state = 'awaiting_review' THEN 1 ELSE 0 END),
            SUM(CASE WHEN exec_state = 'failed' THEN 1 ELSE 0 END)
         FROM nodes WHERE deleted_at IS NULL",
    )?;
    let (a, b, c): (Option<i64>, Option<i64>, Option<i64>) =
        stmt.query_row([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    Ok((a.unwrap_or(0), b.unwrap_or(0), c.unwrap_or(0)))
}

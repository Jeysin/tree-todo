//! SQL 查询层：所有语句集中于此，propagate.rs 与 commands/ 只经由这里访问 SQLite。
//!
//! v0.3：所有「视图查询」一律过滤 `deleted_at IS NULL`（回收站机制）；
//! status 变更统一维护 `completed_at`（统计面板数据来源）。

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{AppError, AppResult};
use crate::model::{ExecDetail, ExecState, Node, NodeExecution, NodeStatus};

const COLS: &str =
    "id, parent_id, content, note, status, position, collapsed, created_at, updated_at, deleted_at, completed_at, \
     exec_state, exec_run_id, exec_agent_id, exec_agent_name, exec_started_at, exec_finished_at, exec_duration_ms, exec_needs_confirm, exec_detail";

fn row_to_node(row: &rusqlite::Row) -> rusqlite::Result<Node> {
    let exec_state = ExecState::parse(&row.get::<_, String>(11)?);
    let execution = if exec_state == ExecState::None {
        None
    } else {
        let detail_raw: Option<String> = row.get(19)?;
        let detail: ExecDetail = detail_raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Some(NodeExecution {
            state: exec_state,
            run_id: row.get(12)?,
            agent_id: row.get::<_, Option<String>>(13)?.unwrap_or_default(),
            agent_name: row.get::<_, Option<String>>(14)?.unwrap_or_default(),
            started_at: row.get::<_, Option<String>>(15)?.unwrap_or_default(),
            finished_at: row.get(16)?,
            duration_ms: row.get(17)?,
            needs_confirmation: row.get::<_, i64>(18)? != 0,
            detail,
        })
    };
    Ok(Node {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        content: row.get(2)?,
        note: row.get(3)?,
        status: NodeStatus::parse(&row.get::<_, String>(4)?),
        position: row.get(5)?,
        collapsed: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        deleted_at: row.get(9)?,
        completed_at: row.get(10)?,
        execution,
    })
}

fn collect(mut stmt: rusqlite::Statement<'_>, params: &[&dyn rusqlite::ToSql]) -> AppResult<Vec<Node>> {
    let rows = stmt.query_map(params, row_to_node)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 常规查询：只返回未删除节点。
pub fn get_node(conn: &Connection, id: &str) -> AppResult<Node> {
    let node = conn
        .query_row(
            &format!("SELECT {COLS} FROM nodes WHERE id = ?1 AND deleted_at IS NULL"),
            params![id],
            row_to_node,
        )
        .optional()?
        .ok_or_else(|| AppError::NodeNotFound(id.to_string()))?;
    Ok(node)
}

pub fn all_nodes(conn: &Connection) -> AppResult<Vec<Node>> {
    let stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM nodes WHERE deleted_at IS NULL"
    ))?;
    collect(stmt, &[])
}

/// 当前文档唯一根任务 id（单根模型；无根时返回 None）。
pub fn root_id(conn: &Connection) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM nodes WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY position LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?)
}

/// 同级末尾插入位置（docs/02 §1.3 分数定位法：max + 1024 步长起步）。
pub fn next_position(conn: &Connection, parent_id: Option<&str>) -> AppResult<f64> {
    let max: Option<f64> = match parent_id {
        Some(pid) => conn.query_row(
            "SELECT MAX(position) FROM nodes WHERE parent_id = ?1 AND deleted_at IS NULL",
            params![pid],
            |r| r.get(0),
        ),
        None => conn.query_row(
            "SELECT MAX(position) FROM nodes WHERE parent_id IS NULL AND deleted_at IS NULL",
            [],
            |r| r.get(0),
        ),
    }
    .optional()?
    .flatten();
    Ok(max.unwrap_or(0.0) + 1024.0)
}

pub fn insert_node(conn: &Connection, node: &Node) -> AppResult<()> {
    upsert_node(conn, node)
}

pub fn update_status(conn: &Connection, id: &str, status: NodeStatus, now: &str) -> AppResult<()> {
    // v0.3：completed_at 随 status 统一维护（done → now，pending → NULL）
    let completed: Option<&str> = if status == NodeStatus::Done {
        Some(now)
    } else {
        None
    };
    conn.execute(
        "UPDATE nodes SET status = ?2, completed_at = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, status.as_str(), completed, now],
    )?;
    Ok(())
}

/// E1 编辑内容：不触发任何状态变化（docs/02 §2.1）。
pub fn update_content(conn: &Connection, id: &str, content: &str, now: &str) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE nodes SET content = ?2, updated_at = ?3 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, content, now],
    )?;
    if n == 0 {
        return Err(AppError::NodeNotFound(id.to_string()));
    }
    Ok(())
}

/// 编辑备注（E1）。
pub fn update_note(conn: &Connection, id: &str, note: &str, now: &str) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE nodes SET note = ?2, updated_at = ?3 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, note, now],
    )?;
    if n == 0 {
        return Err(AppError::NodeNotFound(id.to_string()));
    }
    Ok(())
}

pub fn set_collapsed(conn: &Connection, id: &str, collapsed: bool, now: &str) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE nodes SET collapsed = ?2, updated_at = ?3 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, collapsed as i64, now],
    )?;
    if n == 0 {
        return Err(AppError::NodeNotFound(id.to_string()));
    }
    Ok(())
}

/// 物理删除（彻底删除 / 撤销回放中的删除操作）。级联由 ON DELETE CASCADE 承担。
pub fn delete_node(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM nodes WHERE id = ?1", params![id])?;
    Ok(())
}

/// 子树全部节点（含自身）——级联操作后返回受影响快照用（仅未删节点）。
pub fn subtree_nodes(conn: &Connection, id: &str) -> AppResult<Vec<Node>> {
    let mut stmt = conn.prepare(&format!(
        "WITH RECURSIVE subtree(sid) AS (
            SELECT id FROM nodes WHERE id = ?1
            UNION ALL
            SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.sid
        )
        SELECT {COLS} FROM nodes
        WHERE id IN (SELECT sid FROM subtree) AND deleted_at IS NULL"
    ))?;
    let rows = stmt.query_map(params![id], row_to_node)?;
    let mut nodes = Vec::new();
    for row in rows {
        nodes.push(row?);
    }
    Ok(nodes)
}

/// 子树 id 列表（含自身，仅未删节点）——删除时先收集，供前端从快照中移除。
pub fn subtree_ids(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE subtree(sid) AS (
            SELECT id FROM nodes WHERE id = ?1
            UNION ALL
            SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.sid
        )
        SELECT sid FROM subtree WHERE sid IN (SELECT id FROM nodes WHERE deleted_at IS NULL)",
    )?;
    let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row?);
    }
    Ok(ids)
}

pub fn child_count(conn: &Connection, parent: &str) -> AppResult<i64> {
    let n = conn.query_row(
        "SELECT COUNT(*) FROM nodes WHERE parent_id = ?1 AND deleted_at IS NULL",
        params![parent],
        |r| r.get(0),
    )?;
    Ok(n)
}

pub fn pending_child_count(conn: &Connection, parent: &str) -> AppResult<i64> {
    let n = conn.query_row(
        "SELECT COUNT(*) FROM nodes WHERE parent_id = ?1 AND deleted_at IS NULL AND status != 'done'",
        params![parent],
        |r| r.get(0),
    )?;
    Ok(n)
}

/// 全字段 upsert（撤销/重做与导入用）。
pub fn upsert_node(conn: &Connection, node: &Node) -> AppResult<()> {
    conn.execute(
        "INSERT INTO nodes (id, parent_id, content, note, status, position, collapsed, created_at, updated_at, deleted_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           parent_id = excluded.parent_id,
           content = excluded.content,
           note = excluded.note,
           status = excluded.status,
           position = excluded.position,
           collapsed = excluded.collapsed,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at,
           completed_at = excluded.completed_at",
        params![
            node.id,
            node.parent_id,
            node.content,
            node.note,
            node.status.as_str(),
            node.position,
            node.collapsed as i64,
            node.created_at,
            node.updated_at,
            node.deleted_at,
            node.completed_at,
        ],
    )?;
    Ok(())
}

/// MV1 移动节点：改 parent_id 与 position（防环与传播在 propagate::move_node）。
pub fn move_node(
    conn: &Connection,
    id: &str,
    new_parent: Option<&str>,
    position: f64,
    now: &str,
) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE nodes SET parent_id = ?2, position = ?3, updated_at = ?4 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, new_parent, position, now],
    )?;
    if n == 0 {
        return Err(AppError::NodeNotFound(id.to_string()));
    }
    Ok(())
}

/// 沿 parent 链向上收集（含 start 自身），顺序为 start → ... → 根。
pub fn ancestors(conn: &Connection, start: Option<&str>) -> AppResult<Vec<Node>> {
    let mut out = Vec::new();
    let mut cur = start.map(str::to_string);
    while let Some(cid) = cur {
        let n = get_node(conn, &cid)?;
        cur = n.parent_id.clone();
        out.push(n);
    }
    Ok(out)
}

pub fn children_ids(conn: &Connection, parent: &str) -> AppResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM nodes WHERE parent_id = ?1 AND deleted_at IS NULL")?;
    let rows = stmt.query_map(params![parent], |r| r.get::<_, String>(0))?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row?);
    }
    Ok(ids)
}

/// 折叠/展开全部：只更新状态变化的行，RETURNING 精确返回受影响节点。
pub fn collapse_all(conn: &Connection, collapsed: bool, now: &str) -> AppResult<Vec<Node>> {
    let mut stmt = conn.prepare(&format!(
        "UPDATE nodes SET collapsed = ?1, updated_at = ?2
         WHERE collapsed != ?1 AND deleted_at IS NULL
           AND (parent_id IS NOT NULL OR ?1 = 0)
         RETURNING {COLS}"
    ))?;
    let rows = stmt.query_map(params![collapsed as i64, now], row_to_node)?;
    let mut nodes = Vec::new();
    for row in rows {
        nodes.push(row?);
    }
    Ok(nodes)
}

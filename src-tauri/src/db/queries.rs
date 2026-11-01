//! SQL 查询层：所有语句集中于此，propagate.rs 与 commands/ 只经由这里访问 SQLite。

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{AppError, AppResult};
use crate::model::{Node, NodeStatus};

const COLS: &str =
    "id, parent_id, content, note, status, position, collapsed, created_at, updated_at";

fn row_to_node(row: &rusqlite::Row) -> rusqlite::Result<Node> {
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
    })
}

pub fn get_node(conn: &Connection, id: &str) -> AppResult<Node> {
    let node = conn
        .query_row(
            &format!("SELECT {COLS} FROM nodes WHERE id = ?1"),
            params![id],
            row_to_node,
        )
        .optional()?
        .ok_or_else(|| AppError::NodeNotFound(id.to_string()))?;
    Ok(node)
}

pub fn all_nodes(conn: &Connection) -> AppResult<Vec<Node>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM nodes"))?;
    let rows = stmt.query_map([], row_to_node)?;
    let mut nodes = Vec::new();
    for row in rows {
        nodes.push(row?);
    }
    Ok(nodes)
}

/// 同级末尾插入位置（docs/02 §1.3 分数定位法：max + 1024 步长起步）。
pub fn next_position(conn: &Connection, parent_id: Option<&str>) -> AppResult<f64> {
    let max: Option<f64> = match parent_id {
        Some(pid) => conn.query_row(
            "SELECT MAX(position) FROM nodes WHERE parent_id = ?1",
            params![pid],
            |r| r.get(0),
        ),
        None => conn.query_row(
            "SELECT MAX(position) FROM nodes WHERE parent_id IS NULL",
            [],
            |r| r.get(0),
        ),
    }
    .optional()?
    .flatten();
    Ok(max.unwrap_or(0.0) + 1024.0)
}

pub fn insert_node(conn: &Connection, node: &Node) -> AppResult<()> {
    conn.execute(
        "INSERT INTO nodes (id, parent_id, content, note, status, position, collapsed, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
        ],
    )?;
    Ok(())
}

pub fn update_status(conn: &Connection, id: &str, status: NodeStatus, now: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE nodes SET status = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, status.as_str(), now],
    )?;
    Ok(())
}

/// E1 编辑内容：不触发任何状态变化（docs/02 §2.1）。
pub fn update_content(conn: &Connection, id: &str, content: &str, now: &str) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE nodes SET content = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, content, now],
    )?;
    if n == 0 {
        return Err(AppError::NodeNotFound(id.to_string()));
    }
    Ok(())
}

pub fn set_collapsed(conn: &Connection, id: &str, collapsed: bool, now: &str) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE nodes SET collapsed = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, collapsed as i64, now],
    )?;
    if n == 0 {
        return Err(AppError::NodeNotFound(id.to_string()));
    }
    Ok(())
}

pub fn delete_node(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM nodes WHERE id = ?1", params![id])?;
    Ok(())
}

/// 子树全部节点（含自身）——级联操作后返回受影响快照用。
pub fn subtree_nodes(conn: &Connection, id: &str) -> AppResult<Vec<Node>> {
    let mut stmt = conn.prepare(&format!(
        "WITH RECURSIVE subtree(sid) AS (
            SELECT id FROM nodes WHERE id = ?1
            UNION ALL
            SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.sid
        )
        SELECT {COLS} FROM nodes WHERE id IN (SELECT sid FROM subtree)"
    ))?;
    let rows = stmt.query_map(params![id], row_to_node)?;
    let mut nodes = Vec::new();
    for row in rows {
        nodes.push(row?);
    }
    Ok(nodes)
}

/// 子树 id 列表（含自身）——删除时先收集，供前端从快照中移除。
pub fn subtree_ids(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE subtree(sid) AS (
            SELECT id FROM nodes WHERE id = ?1
            UNION ALL
            SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.sid
        )
        SELECT sid FROM subtree",
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
        "SELECT COUNT(*) FROM nodes WHERE parent_id = ?1",
        params![parent],
        |r| r.get(0),
    )?;
    Ok(n)
}

pub fn pending_child_count(conn: &Connection, parent: &str) -> AppResult<i64> {
    let n = conn.query_row(
        "SELECT COUNT(*) FROM nodes WHERE parent_id = ?1 AND status != 'done'",
        params![parent],
        |r| r.get(0),
    )?;
    Ok(n)
}

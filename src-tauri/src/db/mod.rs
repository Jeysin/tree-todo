pub mod queries;

use std::path::Path;

use chrono::Utc;
use rusqlite::{params, Connection};
use uuid::Uuid;

use crate::error::AppResult;
use crate::model::{Node, NodeStatus};

/// SQLite 数据层入口（docs/02 §1）。
pub struct Db {
    pub conn: Connection,
}

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        let db = Self::init(conn)?;
        // 单根模型：文件库打开时确保存在一个根任务；内存库（测试）不强制。
        db.ensure_root("任务线")?;
        Ok(db)
    }

    /// 单元测试 / 内存库。
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> AppResult<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    /// 迁移框架：读 schema_version，逐版本执行（docs/02 §4）。
    fn migrate(&self) -> AppResult<()> {
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
            [],
        )?;
        let current: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )?;
        if current < 1 {
            self.conn.execute_batch(MIGRATION_V1)?;
            self.conn
                .execute("INSERT INTO schema_version (version) VALUES (1)", [])?;
        }
        if current < 2 {
            self.conn.execute_batch(MIGRATION_V2)?;
            self.conn
                .execute("INSERT INTO schema_version (version) VALUES (2)", [])?;
        }
        if current < 3 {
            self.migrate_single_root()?;
            self.conn
                .execute("INSERT INTO schema_version (version) VALUES (3)", [])?;
        }
        Ok(())
    }

    /// v3：单根迁移 + 移除旧版节点回收站。
    ///
    /// - 旧版软删节点（节点回收站）直接物理删除；回收站改为文档级。
    /// - 多根文档：新建一个「任务线」根，把原有根按 position 顺序挂到新根下。
    /// - 单根 / 空文档保持不变；空文档由 `ensure_root` 在文件库打开时补根。
    fn migrate_single_root(&self) -> AppResult<()> {
        // 旧版节点回收站 → 物理删除，避免遗留不可见数据。
        self.conn
            .execute("DELETE FROM nodes WHERE deleted_at IS NOT NULL", [])?;

        let roots: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT id FROM nodes WHERE parent_id IS NULL ORDER BY position")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        if roots.len() <= 1 {
            return Ok(());
        }

        let ts = Utc::now().to_rfc3339();
        let root_id = Uuid::new_v4().to_string();
        let root_status = {
            let pending: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM nodes WHERE parent_id IS NULL AND status != 'done'",
                [],
                |r| r.get(0),
            )?;
            if pending == 0 {
                NodeStatus::Done
            } else {
                NodeStatus::Pending
            }
        };
        let root = Node {
            id: root_id.clone(),
            parent_id: None,
            content: "任务线".to_string(),
            note: String::new(),
            status: root_status,
            position: 0.0,
            collapsed: false,
            created_at: ts.clone(),
            updated_at: ts.clone(),
            deleted_at: None,
            completed_at: if root_status == NodeStatus::Done {
                Some(ts)
            } else {
                None
            },
        };
        crate::db::queries::insert_node(&self.conn, &root)?;
        self.conn.execute(
            "UPDATE nodes SET parent_id = ?1 WHERE parent_id IS NULL AND id != ?2",
            params![root_id, root.id],
        )?;
        Ok(())
    }

    /// 确保文件库存在唯一根任务；返回是否新建。
    pub fn ensure_root(&self, content: &str) -> AppResult<bool> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM nodes WHERE parent_id IS NULL AND deleted_at IS NULL",
            [],
            |r| r.get(0),
        )?;
        if count > 0 {
            return Ok(false);
        }
        let ts = Utc::now().to_rfc3339();
        let node = Node {
            id: Uuid::new_v4().to_string(),
            parent_id: None,
            content: content.to_string(),
            note: String::new(),
            status: NodeStatus::Pending,
            position: 0.0,
            collapsed: false,
            created_at: ts.clone(),
            updated_at: ts,
            deleted_at: None,
            completed_at: None,
        };
        crate::db::queries::insert_node(&self.conn, &node)?;
        Ok(true)
    }
}

/// v1：nodes 表（与 docs/02 §1.2 保持一致）。
const MIGRATION_V1: &str = r#"
CREATE TABLE nodes (
    id         TEXT PRIMARY KEY,
    parent_id  TEXT,
    content    TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'pending',
    position   REAL NOT NULL,
    collapsed  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX idx_nodes_parent ON nodes(parent_id);
"#;

/// v2（v0.3 M3）：回收站软删除 + 统计完成时间。
const MIGRATION_V2: &str = r#"
ALTER TABLE nodes ADD COLUMN deleted_at TEXT;
ALTER TABLE nodes ADD COLUMN completed_at TEXT;
CREATE INDEX idx_nodes_deleted ON nodes(deleted_at);
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries;

    fn insert_node(conn: &Connection, id: &str, content: &str, position: f64) {
        let ts = Utc::now().to_rfc3339();
        let node = Node {
            id: id.to_string(),
            parent_id: None,
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
        queries::insert_node(conn, &node).unwrap();
    }

    #[test]
    fn migration_v3_wraps_multiple_roots() {
        let path = std::env::temp_dir().join(format!("tree-todo-migrate-{}", Uuid::new_v4()));
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            conn.execute_batch(
                "CREATE TABLE schema_version (version INTEGER NOT NULL);
                 INSERT INTO schema_version (version) VALUES (1);
                 INSERT INTO schema_version (version) VALUES (2);",
            )
            .unwrap();
            conn.execute_batch(MIGRATION_V1).unwrap();
            conn.execute_batch(MIGRATION_V2).unwrap();
            insert_node(&conn, "a", "任务 A", 0.0);
            insert_node(&conn, "b", "任务 B", 1024.0);
        }

        let db = Db::open(&path).unwrap();
        let roots: Vec<String> = {
            let mut stmt = db
                .conn
                .prepare("SELECT id FROM nodes WHERE parent_id IS NULL ORDER BY position")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(roots.len(), 1, "单根迁移后只应有一个根");
        let root = queries::get_node(&db.conn, &roots[0]).unwrap();
        assert_eq!(root.content, "任务线");
        assert_eq!(queries::child_count(&db.conn, &root.id).unwrap(), 2);

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn file_db_ensures_root_but_memory_db_does_not() {
        let path = std::env::temp_dir().join(format!("tree-todo-root-{}", Uuid::new_v4()));
        let db = Db::open(&path).unwrap();
        assert!(queries::root_id(&db.conn).unwrap().is_some());
        drop(db);
        std::fs::remove_file(&path).unwrap();

        let mem = Db::open_in_memory().unwrap();
        assert!(queries::root_id(&mem.conn).unwrap().is_none());
    }
}

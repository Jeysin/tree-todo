pub mod queries;

use std::path::Path;

use rusqlite::Connection;

use crate::error::AppResult;

/// SQLite 数据层入口（docs/02 §1）。
pub struct Db {
    pub conn: Connection,
}

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
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
        Ok(())
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

/// 启动备份（docs/02 §4 / docs/05 M3：保留最近 3 份轮转备份）。
pub fn backup_db(db_path: &Path) -> std::io::Result<()> {
    if !db_path.exists() {
        return Ok(());
    }
    let bak1 = db_path.with_extension("db.bak");
    let bak2 = db_path.with_extension("db.bak2");
    let bak3 = db_path.with_extension("db.bak3");
    // 轮转：bak2 → bak3，bak1 → bak2
    if bak2.exists() {
        let _ = std::fs::rename(&bak2, &bak3);
    }
    if bak1.exists() {
        let _ = std::fs::rename(&bak1, &bak2);
    }
    std::fs::copy(db_path, bak1).map(|_| ())
}

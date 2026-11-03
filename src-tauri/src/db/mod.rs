pub mod exec;
pub mod queries;
pub mod runs;

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Utc;
use rusqlite::{params, Connection, TransactionBehavior};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::model::{Node, NodeStatus};

/// 当前文档库 schema 版本（docs/06 §7.6）。
/// v1 建表、v2 completed_at、v3 单根、v4 执行状态 + 运行账本。
pub const CURRENT_SCHEMA: u32 = 4;

/// SQLite 数据层入口（docs/02 §1）。
pub struct Db {
    pub conn: Connection,
}

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        let db = Self::init(conn, Some(path))?;
        // 单根模型：文件库打开时确保存在一个根任务；内存库（测试）不强制。
        db.ensure_root("任务线")?;
        Ok(db)
    }

    /// 单元测试 / 内存库。
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn, None)
    }

    fn init(conn: Connection, path: Option<&Path>) -> AppResult<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let mut db = Self { conn };
        db.migrate(path)?;
        Ok(db)
    }

    /// 迁移框架：读 schema_version，逐版本执行（docs/06 §7.6）。
    /// 一个版本 = 一个事务；升级前备份；v4 在提交前做数据校验。
    fn migrate(&mut self, path: Option<&Path>) -> AppResult<()> {
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
            [],
        )?;
        let current: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )?;
        if current > i64::from(CURRENT_SCHEMA) {
            return Err(AppError::SchemaTooNew(current as u32));
        }
        if current == i64::from(CURRENT_SCHEMA) {
            return Ok(());
        }

        preflight(&self.conn)?;
        let backup = match path {
            Some(p) => Some(backup_before_migration(&self.conn, p, current as u32)?),
            None => None,
        };
        let backup_path = backup.map(|p| p.to_string_lossy().to_string());

        if current < 1 {
            self.step(1, |tx| Ok(tx.execute_batch(MIGRATION_V1)?))?;
        }
        if current < 2 {
            self.step(2, |tx| Ok(tx.execute_batch(MIGRATION_V2)?))?;
        }
        if current < 3 {
            self.step(3, |tx| Self::migrate_single_root(tx))?;
        }
        if current < 4 {
            // v3 可能新增根节点，所以校验基准取 v3 完成之后、v4 开始之前。
            let before_v4 = node_digest(&self.conn)?;
            self.step(4, |tx| {
                tx.execute_batch(MIGRATION_V4)?;
                // v1–v3 没有账本，补 legacy 记录。
                for (v, name) in [(1, "init"), (2, "completed_at"), (3, "single_root")] {
                    tx.execute(
                        "INSERT OR IGNORE INTO schema_migrations
                         (version, name, applied_at, app_version, duration_ms, backup_path)
                         VALUES (?1, ?2, ?3, 'legacy', 0, NULL)",
                        params![v, name, Utc::now().to_rfc3339()],
                    )?;
                }
                tx.execute(
                    "INSERT INTO schema_migrations
                     (version, name, applied_at, app_version, duration_ms, backup_path)
                     VALUES (4, 'agent_execution', ?1, ?2, 0, ?3)",
                    params![Utc::now().to_rfc3339(), env!("CARGO_PKG_VERSION"), backup_path],
                )?;
                let after = node_digest(tx)?;
                if after != before_v4 {
                    return Err(AppError::Migration(format!(
                        "节点数据校验和不一致：迁移前 {before_v4:?}，迁移后 {after:?}"
                    )));
                }
                let nonzero: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM nodes WHERE exec_state != 'none'",
                    [],
                    |r| r.get(0),
                )?;
                if nonzero != 0 {
                    return Err(AppError::Migration("迁移后 exec_state 应全部为 none".into()));
                }
                let runs: i64 = tx.query_row("SELECT COUNT(*) FROM runs", [], |r| r.get(0))?;
                if runs != 0 {
                    return Err(AppError::Migration("新库 runs 应为空".into()));
                }
                ensure_sqlite_ok(tx)?;
                Ok(())
            })?;
        }
        ensure_sqlite_ok(&self.conn)?;
        Ok(())
    }

    /// 单个版本迁移：事务 + 版本号 + 失败自动回滚。
    fn step<F>(&mut self, version: u32, f: F) -> AppResult<()>
    where
        F: FnOnce(&rusqlite::Transaction<'_>) -> AppResult<()>,
    {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        f(&tx)?;
        tx.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            params![version],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// v3：单根迁移 + 移除旧版节点回收站。
    ///
    /// - 旧版软删节点（节点回收站）直接物理删除；回收站改为文档级。
    /// - 多根文档：新建一个「任务线」根，把原有根按 position 顺序挂到新根下。
    /// - 单根 / 空文档保持不变；空文档由 `ensure_root` 在文件库打开时补根。
    fn migrate_single_root(conn: &Connection) -> AppResult<()> {
    // 旧版节点回收站 → 物理删除，避免遗留不可见数据。
    conn.execute("DELETE FROM nodes WHERE deleted_at IS NOT NULL", [])?;

    let roots: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM nodes WHERE parent_id IS NULL ORDER BY position")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if roots.len() <= 1 {
        return Ok(());
    }

    let ts = Utc::now().to_rfc3339();
    let root_id = Uuid::new_v4().to_string();
    let root_status = {
        let pending: i64 = conn.query_row(
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
            execution: None,
        };
        crate::db::queries::insert_node(conn, &root)?;
        conn.execute(
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
            execution: None,
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

/// v4（v1.1）：执行状态物化列 + 运行账本 + 文档元信息 + 迁移账本。
/// docs/06 §7.2。纯加法：老数据 exec_state 全为 'none'，行为不变。
const MIGRATION_V4: &str = r#"
ALTER TABLE nodes ADD COLUMN exec_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE nodes ADD COLUMN exec_run_id TEXT;
ALTER TABLE nodes ADD COLUMN exec_agent_id TEXT;
ALTER TABLE nodes ADD COLUMN exec_agent_name TEXT;
ALTER TABLE nodes ADD COLUMN exec_started_at TEXT;
ALTER TABLE nodes ADD COLUMN exec_finished_at TEXT;
ALTER TABLE nodes ADD COLUMN exec_duration_ms INTEGER;
ALTER TABLE nodes ADD COLUMN exec_needs_confirm INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN exec_detail TEXT;
CREATE INDEX idx_nodes_exec ON nodes(exec_state) WHERE exec_state <> 'none';

CREATE TABLE runs (
    id           TEXT PRIMARY KEY,
    agent_id     TEXT NOT NULL,
    agent_version TEXT,
    status       TEXT NOT NULL,
    mode         TEXT NOT NULL,
    needs_confirmation INTEGER NOT NULL DEFAULT 0,
    workspace    TEXT,
    model        TEXT,
    effort       TEXT,
    prompt       TEXT NOT NULL,
    session_id   TEXT,
    pid          INTEGER,
    exit_code    INTEGER,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    duration_ms  INTEGER,
    cost_usd     REAL,
    tokens_in    INTEGER,
    tokens_out   INTEGER,
    summary      TEXT,
    error        TEXT,
    reviewed_at  TEXT,
    dismissed_at TEXT,
    log_path     TEXT
);
CREATE INDEX idx_runs_status ON runs(status, started_at DESC);

CREATE TABLE run_nodes (
    run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    node_id      TEXT NOT NULL,
    report       TEXT NOT NULL DEFAULT 'pending',
    review       TEXT NOT NULL DEFAULT 'pending',
    reported_at  TEXT,
    reviewed_at  TEXT,
    summary      TEXT,
    PRIMARY KEY (run_id, node_id)
);
CREATE INDEX idx_run_nodes_node ON run_nodes(node_id, review);

CREATE TABLE dispatch_prefs (
    scope      TEXT NOT NULL,
    scope_id   TEXT NOT NULL,
    agent_id   TEXT,
    workspace  TEXT,
    model      TEXT,
    effort     TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, scope_id)
);

CREATE TABLE doc_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TEXT NOT NULL,
    app_version TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    backup_path TEXT
);
"#;

fn nodes_table_exists(conn: &Connection) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='nodes'",
        [],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn node_digest(conn: &Connection) -> AppResult<(i64, i64)> {
    if !nodes_table_exists(conn)? {
        return Ok((0, 0));
    }
    Ok(conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(LENGTH(id) + LENGTH(COALESCE(parent_id,'')) + LENGTH(content)
                  + LENGTH(note) + LENGTH(status) + COALESCE(completed_at,'')), 0)
         FROM nodes",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

fn ensure_sqlite_ok(conn: &Connection) -> AppResult<()> {
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(AppError::Migration(format!("quick_check 失败: {check}")));
    }
    let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
    let mut rows = stmt.query([])?;
    if rows.next()?.is_some() {
        return Err(AppError::Migration("foreign_key_check 发现悬空引用".into()));
    }
    Ok(())
}

fn preflight(conn: &Connection) -> AppResult<()> {
    ensure_sqlite_ok(conn)?;
    // 迁移前确认可写：建一张临时表再删掉。
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS __migration_probe (x INTEGER); DROP TABLE __migration_probe;",
    )?;
    Ok(())
}

fn backup_before_migration(conn: &Connection, path: &Path, from: u32) -> AppResult<PathBuf> {
    let parent = path.parent().unwrap_or(path);
    let app_dir = if parent.file_name().map(|n| n == "docs").unwrap_or(false) {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    };
    let dir = app_dir
        .join("backups")
        .join(format!("v{CURRENT_SCHEMA}"));
    std::fs::create_dir_all(&dir)?;
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "doc".to_string());
    let name = format!(
        "{stem}-{}-v{from}.db",
        Utc::now().format("%Y%m%d-%H%M%S")
    );
    let target = dir.join(name);
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])?;
    // 备份必须能独立打开且版本正确，否则不允许迁移。
    let backup = Connection::open(&target)?;
    let v: i64 = backup.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version",
        [],
        |r| r.get(0),
    )?;
    if v != i64::from(from) {
        return Err(AppError::Migration(format!(
            "备份校验失败：期望 v{from}，实际 v{v}"
        )));
    }
    Ok(target)
}

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
            execution: None,
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

        drop(db);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn migration_v4_adds_exec_columns_and_keeps_data() {
        let path = std::env::temp_dir().join(format!("tree-todo-v4-{}", Uuid::new_v4()));
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            conn.execute_batch(
                "CREATE TABLE schema_version (version INTEGER NOT NULL);
                 INSERT INTO schema_version (version) VALUES (1),(2),(3);",
            )
            .unwrap();
            conn.execute_batch(MIGRATION_V1).unwrap();
            conn.execute_batch(MIGRATION_V2).unwrap();
            insert_node(&conn, "root", "旧任务", 0.0);
        }

        let db = Db::open(&path).unwrap();
        let version: i64 = db
            .conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 4);

        let nodes = queries::all_nodes(&db.conn).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].content, "旧任务");
        assert!(nodes[0].execution.is_none(), "老数据升级后 exec_state 必须为 none");

        let runs: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM runs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(runs, 0);
        let ledgers: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert!(ledgers >= 4, "迁移账本应包含 v1–v4");

        drop(db);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn newer_schema_is_rejected_without_writing() {
        let path = std::env::temp_dir().join(format!("tree-todo-future-{}", Uuid::new_v4()));
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE schema_version (version INTEGER NOT NULL);
                 INSERT INTO schema_version (version) VALUES (99);",
            )
            .unwrap();
        }
        let err = match Db::open(&path) {
            Ok(_) => panic!("更高版本的 schema 必须被拒绝"),
            Err(e) => e,
        };
        assert!(matches!(err, AppError::SchemaTooNew(99)));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
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

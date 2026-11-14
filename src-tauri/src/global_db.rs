//! 全局数据区（docs/10 §4）：`app_data_dir/global.db`。
//!
//! 与文档库解耦的独立 SQLite 文件，存**可从文档库重算的派生数据**。
//! 硬规则：这里不存任何用户原始数据；删掉整个文件后启动会自动重建，用户无感。
//! 因此版本过高 / 文件损坏时不阻止应用启动，而是把旧文件挪到一边再重建。

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Utc;
use rusqlite::{params, Connection};

use crate::error::{AppError, AppResult};

/// 全局库 schema 版本（与文档库的 `CURRENT_SCHEMA` 完全独立）。
pub const GLOBAL_SCHEMA: u32 = 1;

/// 全局库入口。
pub struct GlobalDb {
    pub conn: Connection,
}

impl GlobalDb {
    /// 打开（必要时重建）全局库。永不因为派生数据的问题阻止应用启动。
    pub fn open(path: &Path) -> AppResult<Self> {
        match Self::try_open(path) {
            Ok(db) => Ok(db),
            Err(err) => {
                eprintln!("全局统计库不可用（{err}），将重建：{}", path.display());
                quarantine(path);
                Self::try_open(path)
            }
        }
    }

    /// 内存库（测试 / 磁盘不可写时的降级）。
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn try_open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> AppResult<Self> {
        conn.execute_batch(DDL)?;
        let version: i64 = conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )?;
        if version > i64::from(GLOBAL_SCHEMA) {
            return Err(AppError::SchemaTooNew(version as u32));
        }
        if version == 0 {
            conn.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
                params![GLOBAL_SCHEMA],
            )?;
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_created_at', ?1)",
                params![now],
            )?;
        }
        Ok(Self { conn })
    }
}

fn quarantine(path: &Path) {
    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    let target = PathBuf::from(format!("{}.old-{stamp}", path.display()));
    if path.exists() {
        if let Err(err) = std::fs::rename(path, &target) {
            eprintln!("挪走旧全局库失败（将尝试直接覆盖）: {err}");
        } else {
            eprintln!("旧全局库已备份到 {}", target.display());
        }
    }
    for suffix in ["-wal", "-shm"] {
        let p = PathBuf::from(format!("{}{suffix}", path.display()));
        let _ = std::fs::remove_file(p);
    }
}

/// `GLOBAL_SCHEMA = 1`（docs/10 §4.4）。
const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

-- 全局 KV：时区快照、日界、最后重建时间
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

-- 每个文档的同步水位（指纹 = "节点数:done数:max(updated_at)"）
CREATE TABLE IF NOT EXISTS doc_sync (
    doc_id      TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    synced_at   TEXT NOT NULL,
    state       TEXT NOT NULL,
    note        TEXT
) WITHOUT ROWID;

-- 核心：文档 × 本地日期 → 当日完成的叶子数
CREATE TABLE IF NOT EXISTS leaf_done_daily (
    doc_id     TEXT NOT NULL,
    local_date TEXT NOT NULL,
    leaf_count INTEGER NOT NULL,
    PRIMARY KEY (doc_id, local_date)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_leaf_daily_date ON leaf_done_daily(local_date);
"#;

/// 读 meta（缺失返回 None）。
pub fn meta_get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM meta WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    Ok(rows.next()?.map(|r| r.get::<_, String>(0)).transpose()?)
}

/// 写 meta（覆盖）。
pub fn meta_set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

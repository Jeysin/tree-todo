//! 全局统计服务（docs/10 §4–§6）。
//!
//! 心智模型：**文档库是唯一真相源，`global.db` 是可随时删除重建的物化聚合**。
//! - 写入：节点变更后 `mark_dirty(doc_id)` → 防抖 worker 重算该文档；
//! - 正确性：不依赖「有没有标脏」，而依赖「文档库指纹对账」——查询前 `flush()`、
//!   后台每 8s 校验当前文档，漏标最多让数字旧 8 秒，不会算错；
//! - 口径：只数**叶子节点**，父节点是分类，永不计数（AGENTS.md 红线第 10 条）；
//! - 范围：只扫描活动文档。回收站文档不扫描，其聚合行在对账时被清理，
//!   因此「进回收站 → 历史下降」「恢复 → 历史回来」由同一条规则自然得到。

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Duration as ChronoDuration, FixedOffset, Local, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::global_db::{meta_get, meta_set, GlobalDb};
use crate::storage::DocStore;

/// 日界固定 00:00（产品决策 5）。保留字段是为了将来改成 04:00 时只需改这里 + 重建。
const DAY_START_HOUR: u32 = 0;

/// 查询范围。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OverviewScope {
    #[default]
    All,
    Folder {
        #[serde(rename = "folderId")]
        folder_id: String,
    },
    Document {
        #[serde(rename = "docId")]
        doc_id: String,
    },
}

/// 总览查询（日期含端点，由前端按「近 12 个月 / 自然年」算好）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewQuery {
    pub start_date: String,
    pub end_date: String,
    #[serde(default)]
    pub scope: OverviewScope,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    pub date: String,
    pub leaf_done: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewResponse {
    pub days: Vec<DayCount>,
    pub total_leaf_done: i64,
    pub active_days: i64,
    pub current_streak: i64,
    pub longest_streak: i64,
    pub today_leaf_done: i64,
    pub synced_docs: i64,
    pub skipped_docs: i64,
    pub stale: bool,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayDetailItem {
    pub doc_id: String,
    pub doc_name: String,
    pub node_id: String,
    pub content: String,
    pub completed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildResult {
    pub docs: i64,
    pub ms: i64,
}

#[derive(Debug, Default)]
pub struct SyncSummary {
    pub synced: i64,
    pub skipped: i64,
}

/// 单个文档的一次算账结果。
struct DocAgg {
    doc_id: String,
    fingerprint: String,
    /// `None` = 文档打不开 / 文件缺失，保留旧行不覆盖。
    buckets: Option<BTreeMap<String, i64>>,
    state: &'static str,
    note: Option<String>,
}

pub struct StatsService {
    docs: DocStore,
    db: Mutex<GlobalDb>,
    dirty: Mutex<HashSet<String>>,
    cv: Condvar,
    current: Mutex<Option<String>>,
    day_start_hour: u32,
    initial_sync_done: AtomicBool,
}

impl StatsService {
    /// 打开磁盘上的全局库；时区或日界变化时全量重建。
    pub fn new(docs: DocStore) -> AppResult<Arc<Self>> {
        let db = GlobalDb::open(&docs.data_dir().join("global.db"))?;
        Self::build(docs, db)
    }

    /// 磁盘不可用时的降级：内存库，功能照常但重启即丢（下次启动会自动重建）。
    pub fn in_memory(docs: DocStore) -> AppResult<Arc<Self>> {
        Self::build(docs, GlobalDb::open_in_memory()?)
    }

    fn build(docs: DocStore, db: GlobalDb) -> AppResult<Arc<Self>> {
        let tz_offset_min = local_offset_minutes();
        let stored: Option<i32> = meta_get(&db.conn, "tz_offset_min")?
            .and_then(|v| v.parse::<i32>().ok());
        let stored_day_start: Option<u32> = meta_get(&db.conn, "day_start_hour")?
            .and_then(|v| v.parse::<u32>().ok());

        let mut db = db;
        meta_set(&db.conn, "tz_offset_min", &tz_offset_min.to_string())?;
        meta_set(&db.conn, "day_start_hour", &DAY_START_HOUR.to_string())?;

        // 时区 / 日界变了 → 历史日期归属全变，必须全部重算（docs/10 §4.8）。
        // 首次打开 stored 为 None，也走这条路径；重算成本是文档数 × 几毫秒。
        let need_rebuild = stored != Some(tz_offset_min) || stored_day_start != Some(DAY_START_HOUR);
        if need_rebuild {
            if let Err(err) = rebuild_all(&mut db, &docs, DAY_START_HOUR) {
                eprintln!("全局统计首次重建失败: {err}");
            }
            meta_set(&db.conn, "last_full_rebuild_at", &Utc::now().to_rfc3339())?;
        }

        Ok(Arc::new(Self {
            docs,
            db: Mutex::new(db),
            dirty: Mutex::new(HashSet::new()),
            cv: Condvar::new(),
            current: Mutex::new(None),
            day_start_hour: DAY_START_HOUR,
            initial_sync_done: AtomicBool::new(false),
        }))
    }

    /// 启动后台线程：进入「防抖 + 8s 巡检」循环。
    ///
    /// 首次全量对账由 `lib.rs` 在「其余文档迁移完成」之后调用 `sync_all()`，
    /// 避免读到还是旧 schema 的文档库。
    pub fn start(self: &Arc<Self>) {
        let svc = Arc::clone(self);
        std::thread::spawn(move || {
            loop {
                let mut dirty = svc.dirty.lock().expect("stats dirty mutex poisoned");
                if dirty.is_empty() {
                    let (guard, _) = svc
                        .cv
                        .wait_timeout(dirty, Duration::from_secs(8))
                        .expect("stats condvar poisoned");
                    dirty = guard;
                }
                if dirty.is_empty() {
                    drop(dirty);
                    svc.poll_current();
                    continue;
                }
                drop(dirty);
                // 防抖：合并连续操作（勾选父节点会连发多次 invoke）。
                std::thread::sleep(Duration::from_millis(600));
                let ids: Vec<String> = {
                    let mut guard = svc.dirty.lock().expect("stats dirty mutex poisoned");
                    guard.drain().collect()
                };
                for id in ids {
                    if let Err(err) = svc.recompute_doc(&id) {
                        eprintln!("重算文档 {id} 统计失败: {err}");
                    }
                }
                svc.poll_current();
            }
        });
    }

    /// 首次全量对账完成后调用；在此之前查询结果带 `stale: true`。
    pub fn mark_initial_sync_done(&self) {
        self.initial_sync_done.store(true, Ordering::Release);
    }

    pub fn set_current(&self, doc_id: &str) {
        if let Ok(mut guard) = self.current.lock() {
            *guard = Some(doc_id.to_string());
        }
    }

    /// 标记文档需要重算（延迟优化；正确性由指纹对账兜底）。
    pub fn mark_dirty(&self, doc_id: &str) {
        if doc_id.is_empty() {
            return;
        }
        if let Ok(mut set) = self.dirty.lock() {
            set.insert(doc_id.to_string());
            self.cv.notify_all();
        }
    }

    /// 查询前刷新：处理脏集合 + 校验当前文档指纹（读己之写，docs/10 C1）。
    pub fn flush(&self) {
        let ids: Vec<String> = match self.dirty.lock() {
            Ok(mut set) => set.drain().collect(),
            Err(_) => Vec::new(),
        };
        for id in ids {
            if let Err(err) = self.recompute_doc(&id) {
                eprintln!("重算文档 {id} 统计失败: {err}");
            }
        }
        self.poll_current();
    }

    fn poll_current(&self) {
        let current = match self.current.lock() {
            Ok(guard) => guard.clone(),
            Err(_) => None,
        };
        let Some(id) = current else { return };
        match self.doc_stale(&id) {
            Ok(true) => {
                if let Err(err) = self.recompute_doc(&id) {
                    eprintln!("巡检重算文档 {id} 失败: {err}");
                }
            }
            Ok(false) => {}
            Err(err) => eprintln!("校验文档 {id} 指纹失败: {err}"),
        }
    }

    /// 全量对账：重算所有活动文档，并清理不在活动集合里的聚合行（含回收站文档）。
    pub fn sync_all(&self) -> AppResult<SyncSummary> {
        let index = self.docs.load_index()?;
        let active: HashSet<String> = index.documents.iter().map(|d| d.id.clone()).collect();
        let aggs: Vec<DocAgg> = index
            .documents
            .iter()
            .map(|d| self.compute_doc(&d.id))
            .collect();

        let mut db = self.db.lock().expect("global db mutex poisoned");
        let tx = db
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = Utc::now().to_rfc3339();
        let mut summary = SyncSummary::default();
        for agg in &aggs {
            match (&agg.buckets, agg.state) {
                (Some(buckets), "ok") => {
                    replace_doc_rows(&tx, &agg.doc_id, buckets)?;
                    summary.synced += 1;
                }
                _ => {
                    // 打不开 → 保留旧行，只标记状态；下次巡检自愈。
                    summary.skipped += 1;
                }
            }
            upsert_doc_sync(&tx, agg, &now)?;
        }
        purge_non_active(&tx, &active)?;
        tx.commit()?;

        meta_set(&db.conn, "last_full_rebuild_at", &now)?;
        Ok(summary)
    }

    fn compute_doc(&self, doc_id: &str) -> DocAgg {
        let path = self.docs.db_path(doc_id);
        if !path.exists() {
            return DocAgg {
                doc_id: doc_id.to_string(),
                fingerprint: String::new(),
                buckets: None,
                state: "missing",
                note: Some("文档数据文件不存在".into()),
            };
        }
        match open_readonly(&path).and_then(|conn| {
            Ok((
                fingerprint(&conn)?,
                buckets_from_conn(&conn, self.day_start_hour)?,
            ))
        }) {
            Ok((fingerprint, buckets)) => DocAgg {
                doc_id: doc_id.to_string(),
                fingerprint,
                buckets: Some(buckets),
                state: "ok",
                note: None,
            },
            Err(err) => DocAgg {
                doc_id: doc_id.to_string(),
                fingerprint: String::new(),
                buckets: None,
                state: "error",
                note: Some(err.to_string()),
            },
        }
    }

    fn doc_stale(&self, doc_id: &str) -> AppResult<bool> {
        let path = self.docs.db_path(doc_id);
        if !path.exists() {
            return Ok(false);
        }
        let conn = open_readonly(&path)?;
        let actual = fingerprint(&conn)?;
        Ok(self.stored_fingerprint(doc_id)?.as_deref() != Some(actual.as_str()))
    }

    fn stored_fingerprint(&self, doc_id: &str) -> AppResult<Option<String>> {
        let db = self.db.lock().expect("global db mutex poisoned");
        let mut stmt = db
            .conn
            .prepare("SELECT fingerprint FROM doc_sync WHERE doc_id = ?1")?;
        Ok(stmt
            .query_row(params![doc_id], |r| r.get::<_, String>(0))
            .optional()?)
    }

    fn recompute_doc(&self, doc_id: &str) -> AppResult<()> {
        let agg = self.compute_doc(doc_id);
        let mut db = self.db.lock().expect("global db mutex poisoned");
        let tx = db
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let (Some(buckets), "ok") = (&agg.buckets, agg.state) {
            replace_doc_rows(&tx, doc_id, buckets)?;
        }
        upsert_doc_sync(&tx, &agg, &Utc::now().to_rfc3339())?;
        tx.commit()?;
        Ok(())
    }

    // ───────────────────── 查询 ─────────────────────

    pub fn overview(&self, query: &OverviewQuery) -> AppResult<OverviewResponse> {
        self.flush();
        let start = parse_date(&query.start_date)?;
        let end = parse_date(&query.end_date)?;
        if start > end {
            return Err(AppError::BadRequest("开始日期不能晚于结束日期".into()));
        }
        let allowed = self.doc_ids_in_scope(&query.scope)?;
        let counts = self.counts_between(&allowed, &query.start_date, &query.end_date)?;

        let today = Local::now().date_naive();
        let today_key = today.format("%Y-%m-%d").to_string();
        let today_leaf_done = if query.start_date <= today_key && today_key <= query.end_date {
            counts.get(&today_key).copied().unwrap_or(0)
        } else {
            self.counts_between(&allowed, &today_key, &today_key)?
                .get(&today_key)
                .copied()
                .unwrap_or(0)
        };

        let mut days = Vec::new();
        let mut total_leaf_done = 0_i64;
        let mut active_days = 0_i64;
        let mut longest_streak = 0_i64;
        let mut run = 0_i64;
        let mut cursor = start;
        while cursor <= end {
            let key = cursor.format("%Y-%m-%d").to_string();
            let leaf_done = counts.get(&key).copied().unwrap_or(0);
            total_leaf_done += leaf_done;
            if leaf_done > 0 {
                active_days += 1;
                run += 1;
                longest_streak = longest_streak.max(run);
            } else {
                run = 0;
            }
            days.push(DayCount {
                date: key,
                leaf_done,
            });
            cursor += ChronoDuration::days(1);
        }

        let positive = self.positive_dates(&allowed)?;
        let current_streak = current_streak(&positive, today);
        let (synced_docs, skipped_docs) = self.sync_counts(&allowed);
        let stale = !self.initial_sync_done.load(Ordering::Acquire)
            || self
                .dirty
                .lock()
                .map(|set| !set.is_empty())
                .unwrap_or(false);

        Ok(OverviewResponse {
            days,
            total_leaf_done,
            active_days,
            current_streak,
            longest_streak,
            today_leaf_done,
            synced_docs,
            skipped_docs,
            stale,
            generated_at: Utc::now().to_rfc3339(),
        })
    }

    pub fn day_detail(
        &self,
        date: &str,
        scope: &OverviewScope,
    ) -> AppResult<Vec<DayDetailItem>> {
        self.flush();
        parse_date(date)?;
        let allowed = self.doc_ids_in_scope(scope)?;
        let index = self.docs.load_index()?;
        let names: HashMap<String, String> = index
            .documents
            .iter()
            .map(|d| (d.id.clone(), d.name.clone()))
            .collect();

        let mut items = Vec::new();
        for doc_id in &allowed {
            let Some(doc_name) = names.get(doc_id) else {
                continue;
            };
            let path = self.docs.db_path(doc_id);
            if !path.exists() {
                continue;
            }
            let Ok(conn) = open_readonly(&path) else {
                continue;
            };
            let Ok(mut stmt) = conn.prepare(
                "SELECT n.id, n.content, n.completed_at
                   FROM nodes n
                  WHERE n.status = 'done'
                    AND n.completed_at IS NOT NULL
                    AND n.deleted_at IS NULL
                    AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id)",
            ) else {
                continue;
            };
            let Ok(rows) = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            }) else {
                continue;
            };
            for row in rows.flatten() {
                let (node_id, content, completed_at) = row;
                if local_day(&completed_at, self.day_start_hour).as_deref() != Some(date) {
                    continue;
                }
                items.push(DayDetailItem {
                    doc_id: doc_id.clone(),
                    doc_name: doc_name.clone(),
                    node_id,
                    content: if content.trim().is_empty() {
                        "(未命名)".to_string()
                    } else {
                        content
                    },
                    completed_at,
                });
            }
        }
        items.sort_by(|a, b| a.completed_at.cmp(&b.completed_at));
        Ok(items)
    }

    pub fn today_count(&self) -> i64 {
        self.flush();
        let today = Local::now().format("%Y-%m-%d").to_string();
        let Ok(allowed) = self.doc_ids_in_scope(&OverviewScope::All) else {
            return 0;
        };
        self.counts_between(&allowed, &today, &today)
            .map(|m| m.get(&today).copied().unwrap_or(0))
            .unwrap_or(0)
    }

    pub fn rebuild(&self) -> AppResult<RebuildResult> {
        let started = Instant::now();
        let summary = self.sync_all()?;
        if let Ok(db) = self.db.lock() {
            let _ = meta_set(&db.conn, "last_full_rebuild_at", &Utc::now().to_rfc3339());
        }
        Ok(RebuildResult {
            docs: summary.synced,
            ms: started.elapsed().as_millis() as i64,
        })
    }

    fn doc_ids_in_scope(&self, scope: &OverviewScope) -> AppResult<HashSet<String>> {
        let index = self.docs.load_index()?;
        let all: HashSet<String> = index.documents.iter().map(|d| d.id.clone()).collect();
        match scope {
            OverviewScope::All => Ok(all),
            OverviewScope::Document { doc_id } => {
                Ok(if all.contains(doc_id) {
                    HashSet::from([doc_id.clone()])
                } else {
                    HashSet::new()
                })
            }
            OverviewScope::Folder { folder_id } => {
                let mut folders: HashSet<String> = HashSet::from([folder_id.clone()]);
                // 目录层级很浅，简单闭包迭代足够（也避免递归爆栈）。
                loop {
                    let before = folders.len();
                    for folder in &index.folders {
                        if let Some(parent) = &folder.parent_id
                            && folders.contains(parent)
                        {
                            folders.insert(folder.id.clone());
                        }
                    }
                    if folders.len() == before {
                        break;
                    }
                }
                Ok(index
                    .documents
                    .iter()
                    .filter(|d| {
                        d.folder_id
                            .as_ref()
                            .map(|f| folders.contains(f))
                            .unwrap_or(false)
                    })
                    .map(|d| d.id.clone())
                    .collect())
            }
        }
    }

    fn counts_between(
        &self,
        allowed: &HashSet<String>,
        start: &str,
        end: &str,
    ) -> AppResult<HashMap<String, i64>> {
        let db = self.db.lock().expect("global db mutex poisoned");
        let mut stmt = db.conn.prepare(
            "SELECT doc_id, local_date, leaf_count
               FROM leaf_done_daily
              WHERE local_date BETWEEN ?1 AND ?2",
        )?;
        let rows = stmt.query_map(params![start, end], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        let mut out: HashMap<String, i64> = HashMap::new();
        for row in rows {
            let (doc_id, date, count) = row?;
            if allowed.contains(&doc_id) {
                *out.entry(date).or_insert(0) += count;
            }
        }
        Ok(out)
    }

    fn positive_dates(&self, allowed: &HashSet<String>) -> AppResult<BTreeSet<String>> {
        let db = self.db.lock().expect("global db mutex poisoned");
        let mut stmt = db
            .conn
            .prepare("SELECT doc_id, local_date, leaf_count FROM leaf_done_daily")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        let mut out = BTreeSet::new();
        for row in rows {
            let (doc_id, date, count) = row?;
            if count > 0 && allowed.contains(&doc_id) {
                out.insert(date);
            }
        }
        Ok(out)
    }

    fn sync_counts(&self, allowed: &HashSet<String>) -> (i64, i64) {
        let Ok(db) = self.db.lock() else {
            return (0, 0);
        };
        let Ok(mut stmt) = db.conn.prepare("SELECT doc_id, state FROM doc_sync") else {
            return (0, 0);
        };
        let Ok(rows) = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }) else {
            return (0, 0);
        };
        let mut synced = 0;
        let mut skipped = 0;
        for row in rows.flatten() {
            if !allowed.contains(&row.0) {
                continue;
            }
            if row.1 == "ok" {
                synced += 1;
            } else {
                skipped += 1;
            }
        }
        (synced, skipped)
    }
}

// ───────────────────── 纯函数 ─────────────────────

fn parse_date(value: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::BadRequest(format!("日期格式应为 YYYY-MM-DD：{value}")))
}

fn local_offset_minutes() -> i32 {
    Local::now().offset().local_minus_utc() / 60
}

/// `completed_at` → 本地日期。`offset_minutes` 显式传入，便于单测跨时区行为。
fn day_of(ts: &str, offset_minutes: i32, day_start_hour: u32) -> Option<String> {
    let dt = DateTime::parse_from_rfc3339(ts).ok()?;
    let offset = FixedOffset::east_opt(offset_minutes * 60)?;
    let local = dt.with_timezone(&offset) - ChronoDuration::hours(i64::from(day_start_hour));
    Some(local.format("%Y-%m-%d").to_string())
}

fn local_day(ts: &str, day_start_hour: u32) -> Option<String> {
    day_of(ts, local_offset_minutes(), day_start_hour)
}

fn current_streak(dates: &BTreeSet<String>, today: NaiveDate) -> i64 {
    let mut cursor = today;
    // 今天还没完成不打断昨天延续的段（早上打开应用看到 0 不至于挫败）。
    if !dates.contains(&cursor.format("%Y-%m-%d").to_string()) {
        cursor -= ChronoDuration::days(1);
    }
    let mut streak = 0;
    while dates.contains(&cursor.format("%Y-%m-%d").to_string()) {
        streak += 1;
        cursor -= ChronoDuration::days(1);
    }
    streak
}

fn open_readonly(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(2))?;
    // 不用 SQLITE_OPEN_READ_ONLY：WAL 库以只读标志打开需要 -shm 可写，容易 SQLITE_READONLY。
    conn.pragma_update(None, "query_only", "ON")?;
    Ok(conn)
}

/// 文档库指纹：任何增删 / 状态变更 / 重命名都会改变三项之一。
fn fingerprint(conn: &Connection) -> AppResult<String> {
    let (count, done, max_updated): (i64, i64, String) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(status = 'done'), 0), COALESCE(MAX(updated_at), '')
           FROM nodes",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    Ok(format!("{count}:{done}:{max_updated}"))
}

/// 只取「仍是 done 的叶子」的完成时间，按本地日期归桶。
fn buckets_from_conn(conn: &Connection, day_start_hour: u32) -> AppResult<BTreeMap<String, i64>> {
    let mut stmt = conn.prepare(
        "SELECT n.completed_at
           FROM nodes n
          WHERE n.status = 'done'
            AND n.completed_at IS NOT NULL
            AND n.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id)",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut buckets: BTreeMap<String, i64> = BTreeMap::new();
    for row in rows {
        let ts = row?;
        if let Some(day) = local_day(&ts, day_start_hour) {
            *buckets.entry(day).or_insert(0) += 1;
        }
    }
    Ok(buckets)
}

fn replace_doc_rows(
    tx: &Transaction<'_>,
    doc_id: &str,
    buckets: &BTreeMap<String, i64>,
) -> AppResult<()> {
    // delete + insert 而不是 upsert：某天归零时行必须消失，不能留下 leaf_count = 0 的僵尸行。
    tx.execute(
        "DELETE FROM leaf_done_daily WHERE doc_id = ?1",
        params![doc_id],
    )?;
    let mut stmt = tx.prepare(
        "INSERT INTO leaf_done_daily (doc_id, local_date, leaf_count) VALUES (?1, ?2, ?3)",
    )?;
    for (day, count) in buckets {
        if *count <= 0 {
            continue;
        }
        stmt.execute(params![doc_id, day, count])?;
    }
    Ok(())
}

fn upsert_doc_sync(tx: &Transaction<'_>, agg: &DocAgg, now: &str) -> AppResult<()> {
    tx.execute(
        "INSERT INTO doc_sync (doc_id, fingerprint, synced_at, state, note)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(doc_id) DO UPDATE SET
             fingerprint = excluded.fingerprint,
             synced_at   = excluded.synced_at,
             state       = excluded.state,
             note        = excluded.note",
        params![
            agg.doc_id,
            agg.fingerprint,
            now,
            agg.state,
            agg.note.as_deref()
        ],
    )?;
    Ok(())
}

/// 清理不在活动文档集合里的聚合行（回收站 / 已删除文档）。
fn purge_non_active(tx: &Transaction<'_>, active: &HashSet<String>) -> AppResult<()> {
    let stale: Vec<String> = {
        let mut stmt = tx.prepare("SELECT DISTINCT doc_id FROM leaf_done_daily")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for doc_id in stale {
        if !active.contains(&doc_id) {
            tx.execute(
                "DELETE FROM leaf_done_daily WHERE doc_id = ?1",
                params![doc_id],
            )?;
        }
    }
    let stale_sync: Vec<String> = {
        let mut stmt = tx.prepare("SELECT doc_id FROM doc_sync")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for doc_id in stale_sync {
        if !active.contains(&doc_id) {
            tx.execute("DELETE FROM doc_sync WHERE doc_id = ?1", params![doc_id])?;
        }
    }
    Ok(())
}

fn rebuild_all(db: &mut GlobalDb, docs: &DocStore, day_start_hour: u32) -> AppResult<()> {
    let index = docs.load_index()?;
    let mut rows: Vec<(String, String, BTreeMap<String, i64>)> = Vec::new();
    for doc in &index.documents {
        let path = docs.db_path(&doc.id);
        if !path.exists() {
            continue;
        }
        if let Ok(conn) = open_readonly(&path)
            && let Ok(buckets) = buckets_from_conn(&conn, day_start_hour)
        {
            let fp = fingerprint(&conn).unwrap_or_default();
            rows.push((doc.id.clone(), fp, buckets));
        }
    }
    let tx = db
        .conn
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute("DELETE FROM leaf_done_daily", [])?;
    tx.execute("DELETE FROM doc_sync", [])?;
    let now = Utc::now().to_rfc3339();
    for (doc_id, fp, buckets) in rows {
        replace_doc_rows(&tx, &doc_id, &buckets)?;
        let agg = DocAgg {
            doc_id,
            fingerprint: fp,
            buckets: None,
            state: "ok",
            note: None,
        };
        upsert_doc_sync(&tx, &agg, &now)?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{queries, Db};
    use crate::model::{Node, NodeStatus};

    fn node(
        id: &str,
        parent_id: Option<&str>,
        status: NodeStatus,
        completed_at: Option<String>,
    ) -> Node {
        let ts = Utc::now().to_rfc3339();
        Node {
            id: id.to_string(),
            parent_id: parent_id.map(str::to_string),
            content: id.to_string(),
            note: String::new(),
            status,
            position: 0.0,
            collapsed: false,
            created_at: ts.clone(),
            updated_at: ts,
            deleted_at: None,
            completed_at,
            execution: None,
        }
    }

    #[test]
    fn day_of_respects_offset_and_day_start() {
        // 2026-11-14T16:30:00Z = 东八区 2026-11-15 00:30
        assert_eq!(
            day_of("2026-11-14T16:30:00+00:00", 480, 0).as_deref(),
            Some("2026-11-15")
        );
        // 日界 04:00 时仍归到前一天
        assert_eq!(
            day_of("2026-11-14T16:30:00+00:00", 480, 4).as_deref(),
            Some("2026-11-14")
        );
    }

    #[test]
    fn buckets_count_only_done_leaves() {
        let db = Db::open_in_memory().unwrap();
        let done_at = Some(Utc::now().to_rfc3339());
        let nodes = [
            node("root", None, NodeStatus::Pending, None),
            // 父节点 done，但它是分类，不计；其下叶子计 1
            node("group", Some("root"), NodeStatus::Done, done_at.clone()),
            node("leaf-1", Some("group"), NodeStatus::Done, done_at.clone()),
            // 根下的 done 叶子再计 1
            node("leaf-2", Some("root"), NodeStatus::Done, done_at.clone()),
            // pending 叶子不计
            node("leaf-3", Some("root"), NodeStatus::Pending, None),
        ];
        for n in &nodes {
            queries::insert_node(&db.conn, n).unwrap();
        }
        let buckets = buckets_from_conn(&db.conn, 0).unwrap();
        assert_eq!(buckets.values().sum::<i64>(), 2, "只数 done 叶子");
    }

    #[test]
    fn done_leaf_with_new_child_drops_out() {
        let db = Db::open_in_memory().unwrap();
        let done_at = Some(Utc::now().to_rfc3339());
        let nodes = vec![
            node("root", None, NodeStatus::Pending, None),
            node("leaf", Some("root"), NodeStatus::Done, done_at.clone()),
        ];
        for n in &nodes {
            queries::insert_node(&db.conn, n).unwrap();
        }
        assert_eq!(
            buckets_from_conn(&db.conn, 0).unwrap().values().sum::<i64>(),
            1
        );
        queries::insert_node(
            &db.conn,
            &node("child", Some("leaf"), NodeStatus::Pending, None),
        )
        .unwrap();
        assert_eq!(
            buckets_from_conn(&db.conn, 0).unwrap().values().sum::<i64>(),
            0,
            "叶子新增子节点后变成分类，退出计数"
        );
    }

    #[test]
    fn deleting_done_leaf_clears_the_day() {
        let db = Db::open_in_memory().unwrap();
        let nodes = vec![
            node("root", None, NodeStatus::Pending, None),
            node(
                "leaf",
                Some("root"),
                NodeStatus::Done,
                Some(Utc::now().to_rfc3339()),
            ),
        ];
        for n in &nodes {
            queries::insert_node(&db.conn, n).unwrap();
        }
        assert_eq!(
            buckets_from_conn(&db.conn, 0).unwrap().values().sum::<i64>(),
            1
        );
        db.conn.execute("DELETE FROM nodes WHERE id = 'leaf'", []).unwrap();
        assert!(
            buckets_from_conn(&db.conn, 0).unwrap().is_empty(),
            "删除后该日应为空桶（不写 0 行）"
        );
    }

    fn date_set(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn current_streak_does_not_break_on_empty_today() {
        let today = NaiveDate::from_ymd_opt(2026, 11, 14).unwrap();
        assert_eq!(
            current_streak(&date_set(&["2026-11-14", "2026-11-13", "2026-11-12"]), today),
            3
        );
        // 今天还是 0：从昨天起算，不打断
        assert_eq!(
            current_streak(&date_set(&["2026-11-13", "2026-11-12"]), today),
            2
        );
        // 昨天也断了
        assert_eq!(current_streak(&date_set(&["2026-11-12"]), today), 0);
    }

    #[test]
    fn trash_excludes_and_restore_includes_history() {
        let dir = std::env::temp_dir().join(format!("tree-todo-stats-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let docs = DocStore::new(dir.clone());
        docs.ensure().unwrap();
        let meta = docs.create("统计测试", None).unwrap();

        {
            let db = Db::open(&docs.db_path(&meta.id)).unwrap();
            let root = queries::root_id(&db.conn).unwrap().unwrap();
            queries::insert_node(
                &db.conn,
                &node(
                    "leaf",
                    Some(root.as_str()),
                    NodeStatus::Done,
                    Some(Utc::now().to_rfc3339()),
                ),
            )
            .unwrap();
        }

        let stats = StatsService::new(docs.clone()).unwrap();
        stats.sync_all().unwrap();
        let today = Local::now().format("%Y-%m-%d").to_string();
        let query = OverviewQuery {
            start_date: today.clone(),
            end_date: today.clone(),
            scope: OverviewScope::All,
        };
        assert_eq!(stats.overview(&query).unwrap().today_leaf_done, 1);

        // 决策 3：进回收站 = 该文档的全部完成记录移出热力图
        docs.trash(&meta.id).unwrap();
        stats.sync_all().unwrap();
        assert_eq!(
            stats.overview(&query).unwrap().today_leaf_done,
            0,
            "回收站文档不应计入"
        );

        // 恢复 = 重新计入
        docs.restore(&meta.id).unwrap();
        stats.sync_all().unwrap();
        assert_eq!(
            stats.overview(&query).unwrap().today_leaf_done,
            1,
            "恢复后应重新计入"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// G-13 的数据前提：节点改完后 `mark_dirty` + 立即读，必须读到新值。
    /// 前端 400ms 防抖只管「什么时候问」，问的时候一定拿到最新数字，所以不用等 worker。
    #[test]
    fn dirty_doc_is_flushed_before_read() {
        let dir = std::env::temp_dir().join(format!("tree-todo-stats-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let docs = DocStore::new(dir.clone());
        docs.ensure().unwrap();
        let meta = docs.create("读己之写", None).unwrap();

        let leaf_id = {
            let db = Db::open(&docs.db_path(&meta.id)).unwrap();
            let root = queries::root_id(&db.conn).unwrap().unwrap();
            queries::insert_node(
                &db.conn,
                &node("leaf", Some(root.as_str()), NodeStatus::Pending, None),
            )
            .unwrap();
            "leaf".to_string()
        };

        let stats = StatsService::new(docs.clone()).unwrap();
        stats.sync_all().unwrap();
        assert_eq!(stats.today_count(), 0);

        // 完成：与 toggle_status 提交后做的事一致——改库、标记脏文档
        {
            let db = Db::open(&docs.db_path(&meta.id)).unwrap();
            queries::update_status(
                &db.conn,
                &leaf_id,
                NodeStatus::Done,
                &Utc::now().to_rfc3339(),
            )
            .unwrap();
        }
        stats.mark_dirty(&meta.id);
        assert_eq!(stats.today_count(), 1, "mark_dirty 后立即读应是最新值");

        // 撤销完成：completed_at 清空，数字回落
        {
            let db = Db::open(&docs.db_path(&meta.id)).unwrap();
            db.conn
                .execute(
                    "UPDATE nodes SET status = 'pending', completed_at = NULL, updated_at = ?1 WHERE id = ?2",
                    rusqlite::params![Utc::now().to_rfc3339(), leaf_id],
                )
                .unwrap();
        }
        stats.mark_dirty(&meta.id);
        assert_eq!(stats.today_count(), 0, "撤销后立即读应回落到 0");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fingerprint_changes_on_status_flip() {
        let db = Db::open_in_memory().unwrap();
        queries::insert_node(
            &db.conn,
            &node("root", None, NodeStatus::Pending, None),
        )
        .unwrap();
        let before = fingerprint(&db.conn).unwrap();
        queries::update_status(&db.conn, "root", NodeStatus::Done, &Utc::now().to_rfc3339())
            .unwrap();
        let after = fingerprint(&db.conn).unwrap();
        assert_ne!(before, after, "状态变化必须改变指纹");
    }
}

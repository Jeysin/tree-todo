//! 多文档存储（docs/05 M3）：每个文档一个独立 SQLite 文件（app_data_dir/docs/{id}.db），
//! 索引记录在 app_data_dir/documents.json；首次启动自动迁移旧的单库文件（含 WAL）。

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::model::{DocIndex, DocMeta};

pub struct DocStore {
    data_dir: PathBuf,
}

impl DocStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    fn index_path(&self) -> PathBuf {
        self.data_dir.join("documents.json")
    }

    pub fn docs_dir(&self) -> PathBuf {
        self.data_dir.join("docs")
    }

    pub fn db_path(&self, id: &str) -> PathBuf {
        self.docs_dir().join(format!("{id}.db"))
    }

    pub fn load_index(&self) -> AppResult<DocIndex> {
        let path = self.index_path();
        if !path.exists() {
            return Ok(DocIndex::default());
        }
        let raw = fs::read_to_string(&path)?;
        let idx: DocIndex = serde_json::from_str(&raw)
            .map_err(|e| AppError::ImportFormat(format!("documents.json 解析失败: {e}")))?;
        Ok(idx)
    }

    fn save_index(&self, idx: &DocIndex) -> AppResult<()> {
        let raw = serde_json::to_string_pretty(idx)
            .map_err(|e| AppError::ImportFormat(format!("documents.json 序列化失败: {e}")))?;
        fs::write(self.index_path(), raw)?;
        Ok(())
    }

    /// 首次启动：确保索引与默认文档存在。
    /// - `documents.json` 已有内容 → 直接返回；
    /// - 否则创建 docs/ 目录；若存在旧的单库（tree-todo.db + WAL/SHM）则迁移为默认文档，否则新建空库。
    pub fn ensure(&self) -> AppResult<DocIndex> {
        fs::create_dir_all(self.docs_dir())?;
        let existing = self.load_index()?;
        if !existing.documents.is_empty() {
            return Ok(existing);
        }

        let id = uuid::Uuid::new_v4().to_string();
        let target = self.db_path(&id);
        let legacy = self.data_dir.join("tree-todo.db");
        if legacy.exists() {
            // 迁移旧库（连同 WAL/SHM，避免丢未 checkpoint 的数据）
            fs::rename(&legacy, &target)?;
            for suffix in ["-wal", "-shm"] {
                let from = self.data_dir.join(format!("tree-todo.db{suffix}"));
                if from.exists() {
                    let to = self.docs_dir().join(format!("{id}.db{suffix}"));
                    let _ = fs::rename(from, to);
                }
            }
        } else {
            let _ = Db::open(&target)?; // 自动建表
        }

        let idx = DocIndex {
            documents: vec![DocMeta {
                id: id.clone(),
                name: "我的任务".to_string(),
                created_at: Utc::now().to_rfc3339(),
            }],
            last_opened: Some(id),
        };
        self.save_index(&idx)?;
        Ok(idx)
    }

    pub fn create(&self, name: &str) -> AppResult<DocMeta> {
        let mut idx = self.ensure()?;
        let id = uuid::Uuid::new_v4().to_string();
        let _ = Db::open(&self.db_path(&id))?;
        let meta = DocMeta {
            id,
            name: name.trim().to_string(),
            created_at: Utc::now().to_rfc3339(),
        };
        idx.documents.push(meta.clone());
        self.save_index(&idx)?;
        Ok(meta)
    }

    pub fn rename(&self, id: &str, name: &str) -> AppResult<DocMeta> {
        let mut idx = self.load_index()?;
        let doc = idx
            .documents
            .iter_mut()
            .find(|d| d.id == id)
            .ok_or_else(|| AppError::NodeNotFound(format!("文档 {id}")))?;
        doc.name = name.trim().to_string();
        let meta = doc.clone();
        self.save_index(&idx)?;
        Ok(meta)
    }

    /// 删除文档（至少保留一个）。返回删除后的索引。
    pub fn remove(&self, id: &str) -> AppResult<DocIndex> {
        let mut idx = self.load_index()?;
        if idx.documents.len() <= 1 {
            return Err(AppError::LastDocument);
        }
        idx.documents.retain(|d| d.id != id);
        if idx.last_opened.as_deref() == Some(id) {
            idx.last_opened = idx.documents.first().map(|d| d.id.clone());
        }
        // 物理删除库文件与备份
        let base = self.docs_dir().join(id);
        for suffix in ["db", "db-wal", "db-shm", "db.bak", "db.bak2", "db.bak3"] {
            let p = PathBuf::from(format!("{}.{}", base.display(), suffix));
            if p.exists() {
                let _ = fs::remove_file(p);
            }
        }
        self.save_index(&idx)?;
        Ok(idx)
    }

    pub fn set_last_opened(&self, id: &str) -> AppResult<()> {
        let mut idx = self.load_index()?;
        idx.last_opened = Some(id.to_string());
        self.save_index(&idx)
    }
}

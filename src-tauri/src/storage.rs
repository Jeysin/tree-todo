//! 多文档存储（docs/05 M3）：每个文档一个独立 SQLite 文件（app_data_dir/docs/{id}.db），
//! 索引记录在 app_data_dir/documents.json；首次启动自动迁移旧的单库文件（含 WAL）。

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::model::{DocIndex, DocMeta, TrashDoc};

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

    pub fn trash_dir(&self) -> PathBuf {
        self.data_dir.join("trash")
    }

    pub fn db_path(&self, id: &str) -> PathBuf {
        self.docs_dir().join(format!("{id}.db"))
    }

    fn trash_base(&self, id: &str) -> PathBuf {
        self.trash_dir().join(id)
    }

    /// 移动文档相关的 db / WAL / SHM / 备份文件。
    fn move_doc_files(&self, id: &str, from: &Path, to: &Path) -> AppResult<()> {
        fs::create_dir_all(to)?;
        let from_base = from.join(id);
        let to_base = to.join(id);
        let mut moved_db = false;
        for suffix in ["db", "db-wal", "db-shm", "db.bak", "db.bak2", "db.bak3"] {
            let src = PathBuf::from(format!("{}.{}", from_base.display(), suffix));
            if !src.exists() {
                continue;
            }
            let dst = PathBuf::from(format!("{}.{}", to_base.display(), suffix));
            fs::rename(&src, &dst)?;
            if suffix == "db" {
                moved_db = true;
            }
        }
        if !moved_db {
            return Err(AppError::NodeNotFound(format!("文档 {id} 的数据库文件不存在")));
        }
        Ok(())
    }

    /// 删除文档相关的所有文件（仅限回收站目录）。
    fn remove_trash_files(&self, id: &str) {
        let base = self.trash_base(id);
        for suffix in ["db", "db-wal", "db-shm", "db.bak", "db.bak2", "db.bak3"] {
            let p = PathBuf::from(format!("{}.{}", base.display(), suffix));
            if p.exists() {
                let _ = fs::remove_file(p);
            }
        }
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
        fs::create_dir_all(self.trash_dir())?;
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
            trash: Vec::new(),
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

    /// 删除文档：移入文档回收站（至少保留一个活动文档）。返回删除后的索引。
    pub fn trash(&self, id: &str) -> AppResult<DocIndex> {
        let mut idx = self.load_index()?;
        if idx.documents.len() <= 1 {
            return Err(AppError::LastDocument);
        }
        let meta = idx
            .documents
            .iter()
            .find(|d| d.id == id)
            .cloned()
            .ok_or_else(|| AppError::NodeNotFound(format!("文档 {id}")))?;
        idx.documents.retain(|d| d.id != id);
        if idx.last_opened.as_deref() == Some(id) {
            idx.last_opened = idx.documents.first().map(|d| d.id.clone());
        }
        self.move_doc_files(id, &self.docs_dir(), &self.trash_dir())?;
        idx.trash.insert(
            0,
            TrashDoc {
                id: meta.id,
                name: meta.name,
                created_at: meta.created_at,
                deleted_at: Utc::now().to_rfc3339(),
            },
        );
        self.save_index(&idx)?;
        Ok(idx)
    }

    /// 回收站文档列表。
    pub fn trash_list(&self) -> AppResult<Vec<TrashDoc>> {
        Ok(self.load_index()?.trash)
    }

    /// 从回收站恢复文档（文件移回 docs/，索引恢复）。
    pub fn restore(&self, id: &str) -> AppResult<DocIndex> {
        let mut idx = self.load_index()?;
        let pos = idx
            .trash
            .iter()
            .position(|d| d.id == id)
            .ok_or_else(|| AppError::NodeNotFound(format!("文档 {id}")))?;
        let doc = idx.trash.remove(pos);
        self.move_doc_files(id, &self.trash_dir(), &self.docs_dir())?;
        idx.documents.push(DocMeta {
            id: doc.id,
            name: doc.name,
            created_at: doc.created_at,
        });
        if idx.last_opened.is_none() {
            idx.last_opened = Some(id.to_string());
        }
        self.save_index(&idx)?;
        Ok(idx)
    }

    /// 从回收站彻底删除文档（物理删除 db 文件）。
    pub fn purge(&self, id: &str) -> AppResult<DocIndex> {
        let mut idx = self.load_index()?;
        idx.trash.retain(|d| d.id != id);
        self.remove_trash_files(id);
        self.save_index(&idx)?;
        Ok(idx)
    }

    /// 清空文档回收站。
    pub fn empty_trash(&self) -> AppResult<DocIndex> {
        let mut idx = self.load_index()?;
        for doc in &idx.trash {
            self.remove_trash_files(&doc.id);
        }
        idx.trash.clear();
        self.save_index(&idx)?;
        Ok(idx)
    }

    pub fn set_last_opened(&self, id: &str) -> AppResult<()> {
        let mut idx = self.load_index()?;
        idx.last_opened = Some(id.to_string());
        self.save_index(&idx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (DocStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("tree-todo-docstore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (DocStore::new(dir.clone()), dir)
    }

    #[test]
    fn doc_trash_restore_and_purge() {
        let (store, dir) = temp_store();
        let first = store.ensure().unwrap().documents[0].clone();
        let second = store.create("第二本").unwrap();

        // 第一个文档移入回收站：文件应移到 trash/，活动列表只剩第二本。
        let idx = store.trash(&first.id).unwrap();
        assert_eq!(idx.documents.len(), 1);
        assert_eq!(idx.documents[0].id, second.id);
        assert_eq!(idx.trash.len(), 1);
        assert_eq!(idx.trash[0].id, first.id);
        assert!(!store.db_path(&first.id).exists());
        assert!(store.trash_base(&first.id).with_extension("db").exists());

        // 恢复：文件回到 docs/，回收站清空。
        let idx = store.restore(&first.id).unwrap();
        assert_eq!(idx.documents.len(), 2);
        assert!(idx.trash.is_empty());
        assert!(store.db_path(&first.id).exists());

        // 再次删除并彻底清除。
        store.trash(&first.id).unwrap();
        let idx = store.purge(&first.id).unwrap();
        assert!(idx.trash.is_empty());
        assert!(!store.trash_base(&first.id).with_extension("db").exists());

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cannot_trash_last_active_doc() {
        let (store, dir) = temp_store();
        let idx = store.ensure().unwrap();
        let id = idx.documents[0].id.clone();
        assert!(matches!(store.trash(&id), Err(AppError::LastDocument)));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

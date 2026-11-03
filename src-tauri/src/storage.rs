//! 多文档存储（docs/05 M3）：每个文档一个独立 SQLite 文件（app_data_dir/docs/{id}.db），
//! 索引记录在 app_data_dir/documents.json；首次启动自动迁移旧的单库文件（含 WAL）。

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::model::{DocIndex, DocMeta, FolderMeta, TrashDoc, TrashFolder, TrashItem};

#[derive(Clone)]
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

    /// 导入失败时回收半成品文档：从索引移除并删掉数据文件（不进回收站）。
    pub fn discard(&self, id: &str) -> AppResult<()> {
        let mut idx = self.load_index()?;
        idx.documents.retain(|d| d.id != id);
        if idx.last_opened.as_deref() == Some(id) {
            idx.last_opened = idx.documents.first().map(|d| d.id.clone());
        }
        self.save_index(&idx)?;
        let base = self.docs_dir().join(id);
        for suffix in ["db", "db-wal", "db-shm"] {
            let p = PathBuf::from(format!("{}.{}", base.display(), suffix));
            if p.exists() {
                let _ = fs::remove_file(p);
            }
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
        let parse = |p: &Path| -> AppResult<DocIndex> {
            let raw = fs::read_to_string(p)?;
            serde_json::from_str(&raw)
                .map_err(|e| AppError::ImportFormat(format!("documents.json 解析失败: {e}")))
        };
        match parse(&path) {
            Ok(idx) => Ok(idx),
            Err(err) => {
                // .bak 兜底：索引损坏时不至于整个应用打不开。
                let bak = path.with_extension("json.bak");
                if bak.exists()
                    && let Ok(idx) = parse(&bak) {
                        let _ = fs::copy(&bak, &path);
                        return Ok(idx);
                    }
                Err(err)
            }
        }
    }

    pub fn save_index(&self, idx: &DocIndex) -> AppResult<()> {
        let path = self.index_path();
        let raw = serde_json::to_string_pretty(idx)
            .map_err(|e| AppError::ImportFormat(format!("documents.json 序列化失败: {e}")))?;
        // 原子写：tmp → fsync → rename，旧文件留一份 .bak（docs/06 §7.6）。
        let tmp = path.with_extension("json.tmp");
        {
            use std::io::Write;
            let mut f = fs::File::create(&tmp)?;
            f.write_all(raw.as_bytes())?;
            f.sync_all()?;
        }
        if path.exists() {
            let _ = fs::copy(&path, path.with_extension("json.bak"));
        }
        fs::rename(&tmp, &path)?;
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
            if existing.schema_version < 2 {
                let mut upgraded = existing;
                upgraded.schema_version = 2;
                self.save_index(&upgraded)?;
                return Ok(upgraded);
            }
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
            schema_version: 2,
            documents: vec![DocMeta {
                id: id.clone(),
                name: "我的任务".to_string(),
                folder_id: None,
                created_at: Utc::now().to_rfc3339(),
                workspace: None,
            }],
            folders: Vec::new(),
            last_opened: Some(id),
            trash: Vec::new(),
            trash_folders: Vec::new(),
        };
        self.save_index(&idx)?;
        Ok(idx)
    }

    /// 新建文档；`folder_id` 为 None 时放在根层级。
    pub fn create(&self, name: &str, folder_id: Option<String>) -> AppResult<DocMeta> {
        let mut idx = self.ensure()?;
        if let Some(fid) = folder_id.as_deref()
            && !idx.folders.iter().any(|f| f.id == fid)
        {
            return Err(AppError::NodeNotFound(format!("目录 {fid}")));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let _ = Db::open(&self.db_path(&id))?;
        let meta = DocMeta {
            id,
            name: name.trim().to_string(),
            folder_id,
            created_at: Utc::now().to_rfc3339(),
            workspace: None,
        };
        idx.documents.push(meta.clone());
        self.save_index(&idx)?;
        Ok(meta)
    }

    /// 新建目录（v0.5 侧边栏层级结构）；`parent_id` 为 None 时放在根层级。
    pub fn create_folder(&self, name: &str, parent_id: Option<String>) -> AppResult<FolderMeta> {
        let mut idx = self.ensure()?;
        if let Some(pid) = parent_id.as_deref()
            && !idx.folders.iter().any(|f| f.id == pid)
        {
            return Err(AppError::NodeNotFound(format!("目录 {pid}")));
        }
        let meta = FolderMeta {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.trim().to_string(),
            parent_id,
            created_at: Utc::now().to_rfc3339(),
        };
        idx.folders.push(meta.clone());
        self.save_index(&idx)?;
        Ok(meta)
    }

    pub fn rename_folder(&self, id: &str, name: &str) -> AppResult<FolderMeta> {
        let mut idx = self.load_index()?;
        let folder = idx
            .folders
            .iter_mut()
            .find(|f| f.id == id)
            .ok_or_else(|| AppError::NodeNotFound(format!("目录 {id}")))?;
        folder.name = name.trim().to_string();
        let meta = folder.clone();
        self.save_index(&idx)?;
        Ok(meta)
    }

    /// 目录子树（含自身）里的目录 id 与文档 id。
    pub fn folder_subtree_ids(&self, id: &str) -> AppResult<(Vec<String>, Vec<String>)> {
        let idx = self.load_index()?;
        if !idx.folders.iter().any(|f| f.id == id) {
            return Err(AppError::NodeNotFound(format!("目录 {id}")));
        }
        let mut folder_ids = vec![id.to_string()];
        let mut cursor = 0;
        while cursor < folder_ids.len() {
            let current = folder_ids[cursor].clone();
            for f in &idx.folders {
                if f.parent_id.as_deref() == Some(current.as_str()) && !folder_ids.contains(&f.id) {
                    folder_ids.push(f.id.clone());
                }
            }
            cursor += 1;
        }
        let doc_ids = idx
            .documents
            .iter()
            .filter(|d| {
                d.folder_id
                    .as_deref()
                    .is_some_and(|f| folder_ids.iter().any(|x| x == f))
            })
            .map(|d| d.id.clone())
            .collect();
        Ok((folder_ids, doc_ids))
    }

    /// 把文档移动到目录（`folder_id` = None 表示根层级）。
    pub fn move_document(&self, id: &str, folder_id: Option<String>) -> AppResult<DocMeta> {
        let mut idx = self.load_index()?;
        if let Some(fid) = folder_id.as_deref()
            && !idx.folders.iter().any(|f| f.id == fid)
        {
            return Err(AppError::NodeNotFound(format!("目录 {fid}")));
        }
        let doc = idx
            .documents
            .iter_mut()
            .find(|d| d.id == id)
            .ok_or_else(|| AppError::NodeNotFound(format!("文档 {id}")))?;
        doc.folder_id = folder_id;
        let meta = doc.clone();
        self.save_index(&idx)?;
        Ok(meta)
    }

    /// 把目录移动到另一个目录（None = 根层级）；禁止移动到自己或自己的子孙下。
    pub fn move_folder(&self, id: &str, parent_id: Option<String>) -> AppResult<FolderMeta> {
        let mut idx = self.load_index()?;
        if !idx.folders.iter().any(|f| f.id == id) {
            return Err(AppError::NodeNotFound(format!("目录 {id}")));
        }
        if let Some(pid) = parent_id.as_deref() {
            if pid == id {
                return Err(AppError::CyclicMove);
            }
            if !idx.folders.iter().any(|f| f.id == pid) {
                return Err(AppError::NodeNotFound(format!("目录 {pid}")));
            }
            let (subtree, _) = self.folder_subtree_ids(id)?;
            if subtree.iter().any(|x| x == pid) {
                return Err(AppError::CyclicMove);
            }
        }
        let folder = idx
            .folders
            .iter_mut()
            .find(|f| f.id == id)
            .ok_or_else(|| AppError::NodeNotFound(format!("目录 {id}")))?;
        folder.parent_id = parent_id;
        let meta = folder.clone();
        self.save_index(&idx)?;
        Ok(meta)
    }

    /// 删除目录：**整个目录（含子目录与其中文档）作为一个条目进回收站**，
    /// 恢复时原样还原结构与文档归属。
    /// 若会把所有文档都删掉则拒绝（至少保留一个文档）。
    pub fn delete_folder(&self, id: &str) -> AppResult<DocIndex> {
        let mut idx = self.load_index()?;
        let (folder_ids, doc_ids) = self.folder_subtree_ids(id)?;
        if !doc_ids.is_empty() && doc_ids.len() == idx.documents.len() {
            return Err(AppError::LastDocument);
        }
        let root = idx
            .folders
            .iter()
            .find(|f| f.id == id)
            .cloned()
            .ok_or_else(|| AppError::NodeNotFound(format!("目录 {id}")))?;
        let folders: Vec<FolderMeta> = idx
            .folders
            .iter()
            .filter(|f| folder_ids.contains(&f.id))
            .cloned()
            .collect();
        let documents: Vec<DocMeta> = idx
            .documents
            .iter()
            .filter(|d| doc_ids.contains(&d.id))
            .cloned()
            .collect();

        for d in &documents {
            self.move_doc_files(&d.id, &self.docs_dir(), &self.trash_dir())?;
        }
        idx.documents.retain(|d| !doc_ids.contains(&d.id));
        idx.folders.retain(|f| !folder_ids.contains(&f.id));
        idx.trash_folders.insert(
            0,
            TrashFolder {
                id: root.id,
                name: root.name,
                deleted_at: Utc::now().to_rfc3339(),
                folders,
                documents,
            },
        );
        if idx
            .last_opened
            .as_deref()
            .is_some_and(|cur| doc_ids.iter().any(|x| x == cur))
        {
            idx.last_opened = idx.documents.first().map(|d| d.id.clone());
        }
        self.save_index(&idx)?;
        Ok(idx)
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

    /// 回收站列表（文档 + 目录，按删除时间倒序）。
    pub fn trash_list(&self) -> AppResult<Vec<TrashItem>> {
        let idx = self.load_index()?;
        let mut items: Vec<TrashItem> = idx
            .trash
            .iter()
            .map(|d| TrashItem {
                id: d.id.clone(),
                kind: "doc".to_string(),
                name: d.name.clone(),
                created_at: d.created_at.clone(),
                deleted_at: d.deleted_at.clone(),
                document_count: 1,
                folder_count: 0,
            })
            .collect();
        for f in &idx.trash_folders {
            items.push(TrashItem {
                id: f.id.clone(),
                kind: "folder".to_string(),
                name: f.name.clone(),
                created_at: f
                    .folders
                    .iter()
                    .find(|x| x.id == f.id)
                    .map(|x| x.created_at.clone())
                    .unwrap_or_default(),
                deleted_at: f.deleted_at.clone(),
                document_count: f.documents.len(),
                folder_count: f.folders.len().saturating_sub(1),
            });
        }
        items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
        Ok(items)
    }

    /// 从回收站恢复（文档或整个目录）。
    pub fn restore(&self, id: &str) -> AppResult<DocIndex> {
        let mut idx = self.load_index()?;

        // 目录条目：目录结构 + 文档一起还原
        if let Some(pos) = idx.trash_folders.iter().position(|f| f.id == id) {
            let entry = idx.trash_folders.remove(pos);
            for d in &entry.documents {
                self.move_doc_files(&d.id, &self.trash_dir(), &self.docs_dir())?;
            }
            let mut folders = entry.folders;
            // 原来的父目录可能已被删除：找不到就回到根层级
            if let Some(root) = folders.iter_mut().find(|f| f.id == entry.id)
                && let Some(pid) = root.parent_id.clone()
                && !idx.folders.iter().any(|f| f.id == pid)
            {
                root.parent_id = None;
            }
            idx.folders.extend(folders);
            idx.documents.extend(entry.documents);
            if idx.last_opened.is_none() {
                idx.last_opened = idx.documents.first().map(|d| d.id.clone());
            }
            self.save_index(&idx)?;
            return Ok(idx);
        }

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
            // 目录可能已被删除：恢复的文档放回根层级，避免指向不存在的目录。
            folder_id: None,
            created_at: doc.created_at,
            workspace: None,
        });
        if idx.last_opened.is_none() {
            idx.last_opened = Some(id.to_string());
        }
        self.save_index(&idx)?;
        Ok(idx)
    }

    /// 从回收站彻底删除（文档或整个目录，物理删除 db 文件）。
    pub fn purge(&self, id: &str) -> AppResult<DocIndex> {
        let mut idx = self.load_index()?;
        if let Some(pos) = idx.trash_folders.iter().position(|f| f.id == id) {
            let entry = idx.trash_folders.remove(pos);
            for d in &entry.documents {
                self.remove_trash_files(&d.id);
            }
            self.save_index(&idx)?;
            return Ok(idx);
        }
        idx.trash.retain(|d| d.id != id);
        self.remove_trash_files(id);
        self.save_index(&idx)?;
        Ok(idx)
    }

    /// 清空文档回收站（文档 + 目录条目）。
    pub fn empty_trash(&self) -> AppResult<DocIndex> {
        let mut idx = self.load_index()?;
        for doc in &idx.trash {
            self.remove_trash_files(&doc.id);
        }
        for folder in &idx.trash_folders {
            for doc in &folder.documents {
                self.remove_trash_files(&doc.id);
            }
        }
        idx.trash.clear();
        idx.trash_folders.clear();
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

    /// 清理临时目录。Windows 上 `RemoveDirectory` 可能因目录变更通知延迟报
    /// ERROR_DIR_NOT_EMPTY（目录实际已空），重试即可；清理失败不判测试失败。
    fn cleanup(dir: &Path) {
        for _ in 0..10 {
            if fs::remove_dir_all(dir).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    #[test]
    fn doc_trash_restore_and_purge() {
        let (store, dir) = temp_store();
        let first = store.ensure().unwrap().documents[0].clone();
        let second = store.create("第二本", None).unwrap();

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

        cleanup(&dir);
    }

    #[test]
    fn cannot_trash_last_active_doc() {
        let (store, dir) = temp_store();
        let idx = store.ensure().unwrap();
        let id = idx.documents[0].id.clone();
        assert!(matches!(store.trash(&id), Err(AppError::LastDocument)));
        cleanup(&dir);
    }

    #[test]
    fn folder_tree_nests_and_delete_restores_whole_subtree() {
        let (store, dir) = temp_store();
        let root_doc = store.ensure().unwrap().documents[0].clone();
        let work = store.create_folder("工作", None).unwrap();
        let q4 = store.create_folder("Q4", Some(work.id.clone())).unwrap();
        let doc = store.create("周报", Some(q4.id.clone())).unwrap();

        let idx = store.load_index().unwrap();
        assert_eq!(idx.folders.len(), 2);
        assert_eq!(
            idx.documents
                .iter()
                .find(|d| d.id == doc.id)
                .unwrap()
                .folder_id
                .as_deref(),
            Some(q4.id.as_str())
        );

        // 删除父目录：整个目录进回收站（一条记录），文档文件移动到 trash/
        let idx = store.delete_folder(&work.id).unwrap();
        assert!(idx.folders.is_empty());
        assert_eq!(idx.documents.len(), 1);
        assert_eq!(idx.documents[0].id, root_doc.id);
        assert!(idx.trash.is_empty(), "目录不该拆成单文档条目");
        assert_eq!(idx.trash_folders.len(), 1);
        assert_eq!(idx.trash_folders[0].id, work.id);
        assert_eq!(idx.trash_folders[0].documents.len(), 1);
        assert!(!store.db_path(&doc.id).exists());
        assert!(store.trash_base(&doc.id).with_extension("db").exists());

        // 恢复：目录结构与文档归属原样还原
        let idx = store.restore(&work.id).unwrap();
        assert!(idx.trash_folders.is_empty());
        assert_eq!(idx.folders.len(), 2);
        assert_eq!(idx.documents.len(), 2);
        assert!(store.db_path(&doc.id).exists());
        let restored = idx.documents.iter().find(|d| d.id == doc.id).unwrap();
        assert_eq!(restored.folder_id.as_deref(), Some(q4.id.as_str()));
        assert!(idx
            .folders
            .iter()
            .any(|f| f.id == q4.id && f.parent_id.as_deref() == Some(work.id.as_str())));

        // 彻底删除目录：同理按整棵目录清理
        store.delete_folder(&work.id).unwrap();
        let idx = store.purge(&work.id).unwrap();
        assert!(idx.trash_folders.is_empty());
        assert!(!store.trash_base(&doc.id).with_extension("db").exists());

        cleanup(&dir);
    }

    #[test]
    fn cannot_delete_folder_holding_every_document() {
        let (store, dir) = temp_store();
        let only = store.ensure().unwrap().documents[0].clone();
        let folder = store.create_folder("全部", None).unwrap();
        let mut idx = store.load_index().unwrap();
        idx.documents
            .iter_mut()
            .find(|d| d.id == only.id)
            .unwrap()
            .folder_id = Some(folder.id.clone());
        store.save_index(&idx).unwrap();

        assert!(matches!(
            store.delete_folder(&folder.id),
            Err(AppError::LastDocument)
        ));
        cleanup(&dir);
    }

    #[test]
    fn move_document_and_folder_respect_hierarchy() {
        let (store, dir) = temp_store();
        let root_doc = store.ensure().unwrap().documents[0].clone();
        let work = store.create_folder("工作", None).unwrap();
        let q4 = store.create_folder("Q4", Some(work.id.clone())).unwrap();

        // 文档移进目录 / 移回根
        let moved = store.move_document(&root_doc.id, Some(q4.id.clone())).unwrap();
        assert_eq!(moved.folder_id.as_deref(), Some(q4.id.as_str()));
        let back = store.move_document(&root_doc.id, None).unwrap();
        assert!(back.folder_id.is_none());

        // 目录不能移进自己或自己的子孙
        assert!(matches!(
            store.move_folder(&work.id, Some(work.id.clone())),
            Err(AppError::CyclicMove)
        ));
        assert!(matches!(
            store.move_folder(&work.id, Some(q4.id.clone())),
            Err(AppError::CyclicMove)
        ));

        // 子目录可以提到根，再挂回去
        let lifted = store.move_folder(&q4.id, None).unwrap();
        assert!(lifted.parent_id.is_none());
        let reattached = store
            .move_folder(&q4.id, Some(work.id.clone()))
            .unwrap();
        assert_eq!(reattached.parent_id.as_deref(), Some(work.id.as_str()));

        cleanup(&dir);
    }
}

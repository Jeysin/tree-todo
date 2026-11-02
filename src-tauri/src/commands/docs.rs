//! 多文档 / 目录命令（docs/05 M3、v0.5 目录层级）：列表 / 新建 / 重命名 / 删除 / 切换。

use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::model::{DocIndex, DocMeta, FolderMeta};
use crate::{AppState, CurrentDoc};

#[tauri::command]
pub fn list_documents(state: State<'_, AppState>) -> AppResult<DocIndex> {
    state.docs.load_index()
}

/// 新建文档；`folder_id` 为空表示放在根层级。
#[tauri::command]
pub fn create_document(
    state: State<'_, AppState>,
    name: String,
    folder_id: Option<String>,
) -> AppResult<DocMeta> {
    state.docs.create(&name, folder_id)
}

#[tauri::command]
pub fn rename_document(state: State<'_, AppState>, id: String, name: String) -> AppResult<DocMeta> {
    state.docs.rename(&id, &name)
}

/// 新建目录；`parent_id` 为空表示放在根层级。
#[tauri::command]
pub fn create_folder(
    state: State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> AppResult<FolderMeta> {
    state.docs.create_folder(&name, parent_id)
}

#[tauri::command]
pub fn rename_folder(state: State<'_, AppState>, id: String, name: String) -> AppResult<FolderMeta> {
    state.docs.rename_folder(&id, &name)
}

/// 把文档移动到目录（folder_id = None 表示根层级）。
#[tauri::command]
pub fn move_document(
    state: State<'_, AppState>,
    id: String,
    folder_id: Option<String>,
) -> AppResult<DocMeta> {
    state.docs.move_document(&id, folder_id)
}

/// 把目录移动到另一个目录（parent_id = None 表示根层级）；禁止移进自身子树。
#[tauri::command]
pub fn move_folder(
    state: State<'_, AppState>,
    id: String,
    parent_id: Option<String>,
) -> AppResult<FolderMeta> {
    state.docs.move_folder(&id, parent_id)
}

/// 删除目录：目录与子目录移除，里面的文档移入回收站（可恢复）。
#[tauri::command]
pub fn delete_folder(state: State<'_, AppState>, id: String) -> AppResult<DocIndex> {
    let (_, doc_ids) = state.docs.folder_subtree_ids(&id)?;
    let mut cur = state.current.lock().expect("current doc mutex poisoned");

    // 当前文档就在待删除目录里：先切到别的文档，避免 Windows 下文件被占用。
    if doc_ids.contains(&cur.id) {
        let index = state.docs.load_index()?;
        let next = index
            .documents
            .iter()
            .find(|d| !doc_ids.contains(&d.id))
            .map(|d| d.id.clone())
            .ok_or(AppError::LastDocument)?;
        let db = Db::open(&state.docs.db_path(&next))?;
        *cur = CurrentDoc { id: next, db };
        state.history.lock().expect("history mutex poisoned").clear();
    }

    state.docs.delete_folder(&id)
}

/// 删除文档：移入文档回收站（至少保留一个活动文档）。若删的是当前文档，先关闭连接再切换。
#[tauri::command]
pub fn delete_document(state: State<'_, AppState>, id: String) -> AppResult<DocIndex> {
    let mut cur = state.current.lock().expect("current doc mutex poisoned");
    let index = state.docs.load_index()?;
    let is_current = cur.id == id;

    // Windows 下不能 rename 正在打开的 SQLite 文件，先切换连接再移动文件。
    if is_current {
        let next = index
            .documents
            .iter()
            .find(|d| d.id != id)
            .map(|d| d.id.clone())
            .ok_or(AppError::LastDocument)?;
        let db = Db::open(&state.docs.db_path(&next))?;
        *cur = CurrentDoc { id: next, db };
        state.history.lock().expect("history mutex poisoned").clear();
    }

    let mut idx = state.docs.trash(&id)?;
    if is_current {
        idx.last_opened = Some(cur.id.clone());
        state.docs.set_last_opened(&cur.id)?;
    }
    Ok(idx)
}

/// 切换当前文档：打开新连接、清空撤销历史、记录 last_opened。
#[tauri::command]
pub fn switch_document(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let path = state.docs.db_path(&id);
    let new_db = Db::open(&path)?;
    let mut cur = state.current.lock().expect("current doc mutex poisoned");
    if cur.id == id {
        return Ok(());
    }
    *cur = CurrentDoc { id: id.clone(), db: new_db };
    state.history.lock().expect("history mutex poisoned").clear();
    state.docs.set_last_opened(&id)?;
    Ok(())
}

#[tauri::command]
pub fn get_current_document(state: State<'_, AppState>) -> AppResult<DocMeta> {
    let cur = state.current.lock().expect("current doc mutex poisoned");
    let idx = state.docs.load_index()?;
    idx.documents
        .into_iter()
        .find(|d| d.id == cur.id)
        .ok_or_else(|| AppError::NodeNotFound(format!("文档 {}", cur.id)))
}

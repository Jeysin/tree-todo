//! 多文档命令（docs/05 M3）：文档列表 / 新建 / 重命名 / 删除 / 切换 / 手动备份。

use tauri::State;

use crate::db::{self, Db};
use crate::error::{AppError, AppResult};
use crate::model::{DocIndex, DocMeta};
use crate::{AppState, CurrentDoc};

#[tauri::command]
pub fn list_documents(state: State<'_, AppState>) -> AppResult<DocIndex> {
    state.docs.load_index()
}

#[tauri::command]
pub fn create_document(state: State<'_, AppState>, name: String) -> AppResult<DocMeta> {
    state.docs.create(&name)
}

#[tauri::command]
pub fn rename_document(state: State<'_, AppState>, id: String, name: String) -> AppResult<DocMeta> {
    state.docs.rename(&id, &name)
}

/// 删除文档（至少保留一个）。若删的是当前文档，自动切换到剩余的第一个。
#[tauri::command]
pub fn delete_document(state: State<'_, AppState>, id: String) -> AppResult<DocIndex> {
    let mut cur = state.current.lock().expect("current doc mutex poisoned");
    let idx = state.docs.remove(&id)?;
    if cur.id == id {
        let next = idx
            .last_opened
            .clone()
            .ok_or(AppError::LastDocument)?;
        let db = Db::open(&state.docs.db_path(&next))?;
        *cur = CurrentDoc {
            id: next.clone(),
            db,
        };
        state.history.lock().expect("history mutex poisoned").clear();
        state.docs.set_last_opened(&next)?;
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

/// 手动备份当前文档（3 份轮转）。
#[tauri::command]
pub fn backup_now(state: State<'_, AppState>) -> AppResult<()> {
    let cur = state.current.lock().expect("current doc mutex poisoned");
    let path = state.docs.db_path(&cur.id);
    db::backup_db(&path)?;
    Ok(())
}

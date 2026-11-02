//! 回收站命令（v0.4）：回收对象是**文档**，不是节点。
//! 节点删除是物理删除，可通过撤销历史恢复；文档删除才进入回收站。

use tauri::State;

use crate::error::AppResult;
use crate::model::{DocIndex, TrashDoc};
use crate::AppState;

/// 回收站文档列表。
#[tauri::command]
pub fn list_trash(state: State<'_, AppState>) -> AppResult<Vec<TrashDoc>> {
    state.docs.trash_list()
}

/// 恢复文档：文档文件从 trash/ 移回 docs/，重新出现在侧边栏。
#[tauri::command]
pub fn restore_trash(state: State<'_, AppState>, id: String) -> AppResult<DocIndex> {
    state.docs.restore(&id)
}

/// 彻底删除单篇回收站文档（物理删除 db 文件）。
#[tauri::command]
pub fn purge_trash(state: State<'_, AppState>, id: String) -> AppResult<DocIndex> {
    state.docs.purge(&id)
}

/// 清空回收站。
#[tauri::command]
pub fn empty_trash(state: State<'_, AppState>) -> AppResult<DocIndex> {
    state.docs.empty_trash()
}

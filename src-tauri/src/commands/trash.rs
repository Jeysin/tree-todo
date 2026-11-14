//! 回收站命令（v0.6）：回收对象是**文档或整个目录**——
//! 删除目录时连同子目录与其中文档作为一个条目进回收站，恢复时原样还原。
//! 节点删除仍是物理删除，可通过撤销历史恢复。

use tauri::State;

use crate::error::AppResult;
use crate::model::{DocIndex, TrashItem};
use crate::AppState;

/// 回收站列表（文档 + 目录）。
#[tauri::command]
pub fn list_trash(state: State<'_, AppState>) -> AppResult<Vec<TrashItem>> {
    state.docs.trash_list()
}

/// 恢复：文档文件 / 目录结构与文档一起回到侧边栏。
#[tauri::command]
pub fn restore_trash(state: State<'_, AppState>, id: String) -> AppResult<DocIndex> {
    let idx = state.docs.restore(&id)?;
    // 恢复后重新计入总览（docs/10 决策 3）：立即对账，不等 worker。
    if let Err(err) = state.stats.sync_all() {
        eprintln!("恢复文档后同步总览失败: {err}");
    }
    Ok(idx)
}

/// 彻底删除单条回收站条目（物理删除 db 文件）。
#[tauri::command]
pub fn purge_trash(state: State<'_, AppState>, id: String) -> AppResult<DocIndex> {
    let idx = state.docs.purge(&id)?;
    if let Err(err) = state.stats.sync_all() {
        eprintln!("彻底删除后同步总览失败: {err}");
    }
    Ok(idx)
}

/// 清空回收站。
#[tauri::command]
pub fn empty_trash(state: State<'_, AppState>) -> AppResult<DocIndex> {
    let idx = state.docs.empty_trash()?;
    if let Err(err) = state.stats.sync_all() {
        eprintln!("清空回收站后同步总览失败: {err}");
    }
    Ok(idx)
}

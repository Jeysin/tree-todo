use std::sync::Mutex;

use tauri::Manager;

mod commands;
mod db;
mod error;
mod history;
mod model;
mod propagate;
mod storage;

use db::Db;
use history::History;
use storage::DocStore;

/// 当前打开的文档（切换文档 = 替换连接 + 清空撤销历史）。
pub struct CurrentDoc {
    pub id: String,
    pub db: Db,
}

/// 全局状态：当前文档 + 撤销历史 + 多文档仓库。
/// 领域红线（AGENTS.md）：所有数据变更必须经此数据层，状态传播只在这里发生。
pub struct AppState {
    pub current: Mutex<CurrentDoc>,
    pub history: Mutex<History>,
    pub docs: DocStore,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let docs = DocStore::new(data_dir);
            let idx = docs.ensure()?;
            let current_id = idx
                .last_opened
                .clone()
                .or_else(|| idx.documents.first().map(|d| d.id.clone()))
                .ok_or_else(|| std::io::Error::other("没有可用文档"))?;
            let db_path = docs.db_path(&current_id);
            // 启动备份（v0.3：保留最近 3 份轮转）
            db::backup_db(&db_path)?;
            let db = Db::open(&db_path)?;
            app.manage(AppState {
                current: Mutex::new(CurrentDoc {
                    id: current_id,
                    db,
                }),
                history: Mutex::new(History::new()),
                docs,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_tree,
            commands::create_node,
            commands::update_content,
            commands::update_note,
            commands::toggle_status,
            commands::delete_node,
            commands::move_node,
            commands::set_collapsed,
            commands::expand_nodes,
            commands::collapse_all,
            commands::undo,
            commands::redo,
            commands::list_trash,
            commands::restore_trash,
            commands::purge_trash,
            commands::empty_trash,
            commands::list_documents,
            commands::create_document,
            commands::rename_document,
            commands::delete_document,
            commands::switch_document,
            commands::get_current_document,
            commands::backup_now,
            commands::export_json,
            commands::import_json,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

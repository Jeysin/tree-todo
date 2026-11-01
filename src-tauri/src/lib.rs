use std::sync::Mutex;

use tauri::Manager;

mod commands;
mod db;
mod error;
mod history;
mod model;
mod propagate;

use db::Db;
use history::History;

/// 全局状态：SQLite 连接 + 撤销历史（均为 Mutex 保证跨线程安全）。
/// 领域红线（AGENTS.md）：所有数据变更必须经此数据层，状态传播只在这里发生。
pub struct AppState {
    pub db: Mutex<Db>,
    pub history: Mutex<History>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("tree-todo.db");
            // 启动备份（docs/02 §4：v0.1 保留最近 1 份 .bak）
            db::startup_backup(&db_path)?;
            let db = Db::open(&db_path)?;
            app.manage(AppState {
                db: Mutex::new(db),
                history: Mutex::new(History::new()),
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
            commands::export_json,
            commands::import_json,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use std::sync::Mutex;

use tauri::menu::{IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

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

/// 原生菜单里 File 菜单项的 id（前端监听事件做实际导出/导入）。
const MENU_EXPORT_ALL: &str = "export_all";
const MENU_IMPORT: &str = "import_bundle";

/// 在系统菜单栏的 File 菜单里挂全局「导出全部 / 导入」入口。
/// macOS 是屏幕顶部菜单栏，Windows / Linux 是窗口菜单。
fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    let export = MenuItem::with_id(
        app,
        MENU_EXPORT_ALL,
        "导出全部…",
        true,
        Some("CmdOrCtrl+Shift+E"),
    )?;
    let import = MenuItem::with_id(
        app,
        MENU_IMPORT,
        "导入…",
        true,
        Some("CmdOrCtrl+Shift+I"),
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let items: [&dyn IsMenuItem<_>; 3] = [&export, &import, &separator];

    // 默认菜单里通常已有 File（Linux 没有），有就插到最前面，没有就自己建一个。
    let mut existing = None;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(sub) = item
            && sub.text()? == "File"
        {
            existing = Some(sub);
            break;
        }
    }
    match existing {
        Some(sub) => sub.insert_items(&items, 0)?,
        None => {
            let sub = Submenu::with_items(app, "File", true, &items)?;
            let index = if cfg!(target_os = "macos") { 1 } else { 0 };
            menu.insert(&sub, index)?;
        }
    }
    app.set_menu(menu)?;
    Ok(())
}

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
            // 菜单初始化失败不应阻止应用启动（只是没有全局导出/导入入口）
            if let Err(err) = install_menu(app) {
                eprintln!("初始化系统菜单失败: {err}");
            }
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
            commands::create_folder,
            commands::rename_folder,
            commands::move_folder,
            commands::move_document,
            commands::delete_folder,
            commands::switch_document,
            commands::get_current_document,
            commands::export_document,
            commands::export_folder,
            commands::export_all,
            commands::import_bundle,
        ])
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_EXPORT_ALL => {
                let _ = app.emit("menu:export-all", ());
            }
            MENU_IMPORT => {
                let _ = app.emit("menu:import", ());
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

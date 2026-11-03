use std::sync::{Arc, Mutex};

use tauri::menu::{IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

mod agents;
mod commands;
mod db;
mod error;
mod history;
mod model;
mod propagate;
mod runtime;
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
    /// 本地回执服务 + 运行映射（docs/06 §6.3）。
    pub runtime: Arc<runtime::RuntimeState>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 主窗口：从配置移到代码里创建，便于按需追加 WebView2 参数。
            // 验收钩子：设置 TREE_TODO_CDP_PORT 后开启远程调试（仅本机验收用，不设则与默认完全一致）。
            let mut win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Tree Todo")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0);
            if let Ok(port) = std::env::var("TREE_TODO_CDP_PORT")
                && let Ok(port) = port.trim().parse::<u32>()
                && port > 0
            {
                win = win.additional_browser_args(&format!(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
                ));
            }
            win.build()?;

            // 菜单初始化失败不应阻止应用启动（只是没有全局导出/导入入口）
            if let Err(err) = install_menu(app) {
                eprintln!("初始化系统菜单失败: {err}");
            }
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let docs = DocStore::new(data_dir.clone());
            let idx = docs.ensure()?;
            // 回收站自动清理（v0.6）：启动时按索引里的保留天数清理一次，之后每小时随
            // expire_loop 再扫一遍；0 表示用户关闭了自动清理。
            if let Err(err) = docs.purge_expired_trash(idx.trash_retention_days) {
                eprintln!("回收站自动清理失败: {err}");
            }
            let current_id = idx
                .last_opened
                .clone()
                .or_else(|| idx.documents.first().map(|d| d.id.clone()))
                .ok_or_else(|| std::io::Error::other("没有可用文档"))?;
            let db_path = docs.db_path(&current_id);
            let db = Db::open(&db_path)?;
            db::exec::reconcile(&db.conn)?;
            let runtime = runtime::start(app.handle().clone(), data_dir)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            app.manage(AppState {
                current: Mutex::new(CurrentDoc {
                    id: current_id,
                    db,
                }),
                history: Mutex::new(History::new()),
                docs,
                runtime,
            });

            // 后台补齐其余文档的迁移（docs/06 §7.6）。
            // 当前文档已在上面同步迁移完成；其余文档在后台逐个迁移，
            // 用户切到哪个文档时就已经是新版，不用等。
            let docs2 = app.state::<AppState>().docs.clone();
            std::thread::spawn(move || migrate_remaining(&docs2));

            // 24h 过期收口线程（docs/06 v2 D32）：每小时扫一遍所有文档，
            // dispatched 超过 24h 的 run 收口为 cancelled·expired（无节点投影，无需通知）。
            let docs3 = app.state::<AppState>().docs.clone();
            std::thread::spawn(move || expire_loop(&docs3));
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
            commands::get_settings,
            commands::set_trash_retention_days,
            commands::delete_folder,
            commands::switch_document,
            commands::get_current_document,
            commands::export_document,
            commands::export_folder,
            commands::export_all,
            commands::import_bundle,
            commands::copy_prompt,
            commands::preview_prompt,
            commands::list_runs,
            commands::get_run,
            commands::close_run,
            commands::accept_run,
            commands::reject_run,
            commands::accept_node,
            commands::dismiss_node,
            commands::exec_counts,
            commands::list_pending_reviews,
            commands::purge_runs,
            commands::open_path,
            commands::copy_text,
            commands::get_mcp_config,
            commands::reset_mcp_token,
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

/// 后台补齐其余文档的 schema 迁移（docs/06 §7.6）。
///
/// 只迁移「还没到当前 schema」的文档；单个文档失败不影响其它文档，
/// 失败信息写日志，等用户切到那个文档时再重试（那时会走同步迁移路径）。
fn migrate_remaining(docs: &DocStore) {
    let Ok(idx) = docs.load_index() else {
        return;
    };
    for doc in &idx.documents {
        let path = docs.db_path(&doc.id);
        if !path.exists() {
            continue;
        }
        match Db::open(&path) {
            Ok(_db) => {
                // 打开即完成迁移；立即 drop，避免长期占用文件句柄。
            }
            Err(e) => {
                eprintln!("迁移文档 {} 失败: {e}", doc.id);
            }
        }
    }
}

/// 24h 过期收口（docs/06 v2 D32）：每小时扫一遍所有文档库，
/// 把 dispatched 超过 24h 的 run 收口为 cancelled·expired。
fn expire_loop(docs: &DocStore) {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
        let cutoff = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
        let Ok(idx) = docs.load_index() else {
            continue;
        };
        // 回收站自动清理也搭这班每小时的车（启动时已清理过一次）。
        if let Err(e) = docs.purge_expired_trash(idx.trash_retention_days) {
            eprintln!("回收站自动清理失败: {e}");
        }
        for doc in &idx.documents {
            let path = docs.db_path(&doc.id);
            if !path.exists() {
                continue;
            }
            let Ok(conn) = rusqlite::Connection::open(&path) else {
                continue;
            };
            let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
            match db::runs::expire_dispatched(&conn, &cutoff) {
                Ok(0) => {}
                Ok(n) => eprintln!("文档 {} 过期收口 {n} 条 dispatched run", doc.id),
                Err(e) => eprintln!("文档 {} 过期扫描失败: {e}", doc.id),
            }
        }
    }
}

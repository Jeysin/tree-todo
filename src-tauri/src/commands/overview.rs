//! 总览 / 日历热力图命令（docs/10 §6.2）：薄层，校验与查询都在 stats.rs。

use tauri::State;

use crate::error::AppResult;
use crate::stats::{
    DayDetailItem, OverviewQuery, OverviewResponse, OverviewScope, RebuildResult,
};
use crate::AppState;

/// 总览聚合：范围查询 + KPI + 连续天数。返回前会 flush（读己之写）。
#[tauri::command]
pub fn get_overview(
    state: State<'_, AppState>,
    query: OverviewQuery,
) -> AppResult<OverviewResponse> {
    state.stats.overview(&query)
}

/// 某一天的完成明细（只含当前仍存在的叶子）。
#[tauri::command]
pub fn get_overview_day(
    state: State<'_, AppState>,
    date: String,
    scope: OverviewScope,
) -> AppResult<Vec<DayDetailItem>> {
    state.stats.day_detail(&date, &scope)
}

/// 今天的叶子完成数（侧栏徽标）。
#[tauri::command]
pub fn get_overview_today(state: State<'_, AppState>) -> AppResult<i64> {
    Ok(state.stats.today_count())
}

/// 手动全量重建（设置页 / 排查用）。
#[tauri::command]
pub fn rebuild_overview(state: State<'_, AppState>) -> AppResult<RebuildResult> {
    state.stats.rebuild()
}

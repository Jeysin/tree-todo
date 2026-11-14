/**
 * 英文词典：以中文原文为 key（zh 模式直接回退到 key 本身）。
 * 含变量的文案统一使用 `{name}` 形式占位，由 index.ts 的 translate 替换。
 */
export const EN: Record<string, string> = {
  // ── 通用 ──
  '加载中…': 'Loading…',
  '读取中…': 'Loading…',
  '保存中…': 'Saving…',
  '保存失败': 'Failed to save',
  '操作失败': 'Operation failed',
  '撤销': 'Undo',
  '已撤销': 'Undone',
  '重做': 'Redo',
  '已重做': 'Redone',
  '没有可撤销的操作': 'Nothing to undo',
  '撤销失败': 'Failed to undo',
  '重做失败': 'Failed to redo',
  '删除': 'Delete',
  '删除失败': 'Failed to delete',
  '复制失败': 'Failed to copy',
  '粘贴失败': 'Failed to paste',
  '导出失败': 'Failed to export',
  '导入失败': 'Failed to import',
  '重命名失败': 'Failed to rename',
  '移动失败': 'Failed to move',
  '未命名': 'Untitled',
  '(未命名)': '(Untitled)',
  '-目录': '-folder',
  '-全部': '-all',
  '未命名文档': 'Untitled document',
  '未命名目录': 'Untitled folder',
  '未命名任务线': 'Untitled task line',
  '关闭': 'Close',
  '关闭 (Esc)': 'Close (Esc)',
  '关闭（Esc）': 'Close (Esc)',
  '取消': 'Cancel',
  '返回': 'Back',
  '刷新': 'Refresh',
  '重试': 'Retry',
  '更多': 'More',
  '新建': 'New',
  '导出': 'Export',
  '恢复': 'Restore',
  '恢复失败': 'Failed to restore',
  '已恢复': 'Restored',
  '数据读取失败': 'Failed to load data',
  '状态切换失败': 'Failed to update status',
  '验收失败': 'Failed to review',
  '彻底删除失败': 'Failed to permanently delete',
  '已彻底删除': 'Permanently deleted',
  '清空失败': 'Failed to empty trash',
  '回收站已清空': 'Trash emptied',

  // ── 节点复制 / 粘贴 ──
  '请先选中要复制的节点': 'Select a node to copy first',
  '请先选中要粘贴到的节点': 'Select a node to paste into first',
  '剪贴板为空，请先复制节点': 'Clipboard is empty. Copy nodes first',
  '请先复制节点': 'Copy nodes first',
  '其他文档': 'another document',
  '来自「{name}」：{summary}（共 {n} 个节点）': 'From "{name}": {summary} ({n} nodes)',
  '已复制「{name}」': 'Copied "{name}"',
  '（共 {n} 个节点）': '({n} nodes)',
  '已粘贴 {n} 个节点 · 撤销': 'Pasted {n} nodes · Undo',
  '已删除「{name}」· 撤销': 'Deleted "{name}" · Undo',
  '已删除 · 撤销': 'Deleted · Undo',
  '根任务不可删除': 'The root task cannot be deleted',
  '已关闭「隐藏已完成」以定位该节点': 'Turned off "Hide completed" to locate this node',

  // ── 导出 / 导入 ──
  '导出文档': 'Export document',
  '导出目录（含子目录与全部文档）': 'Export folder (including subfolders and all documents)',
  '导出全部文档与目录': 'Export all documents and folders',
  '导入 tree-todo 导出文件（整体还原为文档或目录）':
    'Import a tree-todo export (restore as a document or folder)',
  'tree-todo 导出': 'tree-todo export',
  '已导出文档「{name}」': 'Exported document "{name}"',
  '已导出目录「{name}」': 'Exported folder "{name}"',
  '已导出全部文档与目录': 'Exported all documents and folders',
  '已导入并打开文档': 'Imported and opened document',
  '已导入 {n} 个文档，已打开「{name}」': 'Imported {n} documents, opened "{name}"',
  '已导入目录': 'Imported folder',
  '文件里没有可导入的内容': 'No importable content in this file',
  '切换文档失败': 'Failed to switch document',
  '创建节点失败': 'Failed to create node',
  '新建文档失败': 'Failed to create document',
  '新建目录失败': 'Failed to create folder',
  '删除目录失败': 'Failed to delete folder',
  '已移动文档': 'Document moved',
  '已移动目录': 'Folder moved',
  '删除文档失败': 'Failed to delete document',
  '已删除目录「{name}」，可从回收站整体恢复':
    'Deleted folder "{name}". You can restore it from Trash',
  '已删除目录，可从回收站整体恢复': 'Deleted folder. You can restore it from Trash',

  // ── 右键菜单 / 快捷键说明 ──
  '查看详情': 'View details',
  '复制节点（含子树）': 'Copy node (with subtree)',
  '粘贴为子节点': 'Paste as child',
  '复制 Prompt': 'Copy Prompt',
  '复制 Prompt（带回执）': 'Copy Prompt (with receipt)',
  '复制 Prompt（纯文本）': 'Copy Prompt (plain text)',
  '带回执': 'with receipt',
  '纯文本': 'plain text',
  '复用上一轮': 'reused last run',
  'Prompt 已复制（{label}）{scope} · {lines} 行{suffix}':
    'Prompt copied ({label}){scope} · {lines} lines{suffix}',
  '已标记结束': 'Run marked as finished',
  '已验收，任务已勾选': 'Approved; task marked as completed',
  '已驳回，反馈已写回备注': 'Rejected; feedback written to the note',
  '驳回失败': 'Failed to reject',
  '删除节点': 'Delete node',
  '打开 / 关闭节点详情': 'Open / close node details',
  '打开设置': 'Open settings',
  '新建与编辑': 'Create & edit',
  '在根任务下新建': 'New task under root',
  '新建子任务': 'New subtask',
  '新建同级任务': 'New sibling task',
  '编辑节点': 'Edit node',
  '取消编辑 / 关闭搜索': 'Cancel editing / close search',
  '状态': 'Status',
  '完成 / 取消完成': 'Complete / uncomplete',
  '视图': 'View',
  '树形视图': 'Tree view',
  '平铺视图': 'List view',
  '统计视图': 'Stats view',
  '树形视图 (Ctrl+1)': 'Tree view (Ctrl+1)',
  '平铺视图 (Ctrl+2)': 'List view (Ctrl+2)',
  '统计视图 (Ctrl+3)': 'Stats view (Ctrl+3)',
  '总览': 'Overview',
  '搜索': 'Search',
  '搜索 (Ctrl+F)': 'Search (Ctrl+F)',
  '适应视图': 'Fit view',
  '适应视图 (Shift+1)': 'Fit view (Shift+1)',
  '平移画布': 'Pan canvas',
  '折叠 / 展开': 'Collapse / expand',
  '折叠全部': 'Collapse all',
  '展开全部': 'Expand all',
  '隐藏已完成节点': 'Hide completed nodes',
  '快捷键': 'Shortcuts',
  '常用快捷键': 'Shortcuts',
  '树形': 'Tree',
  '平铺': 'List',
  '统计': 'Stats',
  '设置': 'Settings',
  '设置（Ctrl+,）': 'Settings (Ctrl+,)',
  '回收站': 'Trash',
  '待验收 {n}': '{n} to review',
  '{n} 个任务待验收': '{n} tasks to review',
  '{n} 个任务执行中': '{n} tasks running',
  '拖拽': 'drag',

  // ── 状态栏 ──
  '个文档': 'documents',
  '{n} 个文档': '{n} documents',
  '正在同步…': 'Syncing…',
  '已同步': 'Synced',
  '{n} 个文档暂时无法读取': '{n} documents temporarily unavailable',
  '不含回收站 · 按本地 00:00 分日': 'Excludes Trash · Days split at local 00:00',
  '待处理': 'Pending',
  '已完成': 'Completed',
  '叶子完成率': 'Leaf completion',
  'AI 执行中 {n}': 'AI running {n}',
  '缩小': 'Zoom out',
  '放大': 'Zoom in',

  // ── 搜索 ──
  '搜索节点内容或备注…': 'Search node content or notes…',
  '没有匹配的节点': 'No matching nodes',

  // ── 侧边栏 ──
  '文档': 'Documents',
  '根目录': 'Root',
  '在「{name}」下新建': 'New in "{name}"',
  '新建文档': 'New document',
  '新建目录': 'New folder',
  '新建子目录': 'New subfolder',
  '导入到此目录…': 'Import into this folder…',
  '移动到…': 'Move to…',
  '重命名': 'Rename',
  '删除目录': 'Delete folder',
  '删除文档': 'Delete document',
  '没有可选目录': 'No folders available',
  '拖拽调整侧边栏宽度': 'Drag to resize sidebar',
  '移到根目录末尾': 'Move to end of root',
  '折叠目录': 'Collapse folder',
  '展开目录': 'Expand folder',
  '{name}（双击重命名）': '{name} (double-click to rename)',
  '总览：全部文档的完成记录 (Ctrl/⌘+4)':
    'Overview: completion history across all documents (Ctrl/⌘+4)',
  '今天完成 {n} 个叶子任务': '{n} leaf tasks completed today',
  '查看更新进度': 'View update progress',
  '检查更新': 'Check for updates',
  '移入回收站': 'Move to Trash',
  '删除目录「{name}」？\n\n{detail}': 'Delete folder "{name}"?\n\n{detail}',
  '整个目录（含 {n} 个文档）会移入回收站，可随时整体恢复。':
    'The whole folder ({n} documents) will be moved to Trash and can be restored anytime.',
  '目录为空，删除后可从回收站恢复。':
    'The folder is empty. It can be restored from Trash after deletion.',
  '将文档「{name}」移入回收站？\n\n文档数据会保留，可从回收站恢复。':
    'Move "{name}" to Trash?\n\nThe data will be kept and can be restored from Trash.',

  // ── 节点详情 ──
  '排队中（旧数据）': 'Queued (legacy data)',
  '执行中': 'Running',
  '待验收': 'Awaiting review',
  '执行失败': 'Failed',
  '执行': 'Execution',
  '未执行。右键「复制 Prompt（带回执）」粘贴给你的 AI Agent，Agent 开始执行后这里会亮起。':
    'Not started. Right-click "Copy Prompt (with receipt)" and paste it to your AI agent; this panel lights up when the agent starts.',
  '· 未收到回执': '· no receipt received',
  '开始': 'Started',
  '回执': 'Receipt',
  '标记结束': 'Mark as finished',
  'Agent 未回报完成时计时不会自动停止，可手动收口':
    'If the agent never reports completion, the timer keeps running; close it manually.',
  '通过并完成': 'Approve & complete',
  '驳回': 'Reject',
  '执行详情': 'Run details',
  '重新复制（带回执）': 'Copy again (with receipt)',
  '忽略': 'Dismiss',
  '等待中': 'Waiting',
  '驳回原因（会写回节点备注）': 'Rejection reason (written to the node note)',
  '确认驳回': 'Confirm rejection',
  '补充说明': 'Notes',
  '补充说明（可选）——标题已经足够清楚时不必填':
    'Notes (optional) — skip if the title is clear enough',
  '自动保存 · 会随标题一起组装进 Prompt':
    'Auto-saved · included with the title in the Prompt',
  '上次执行：{name}': 'Last run: {name}',
  '右键复制 Prompt，粘贴给你的 AI Agent':
    'Right-click Copy Prompt and paste it to your AI agent',

  // ── 执行详情抽屉 ──
  '已复制，等待 Agent 开始': 'Copied, waiting for the agent',
  '已收口': 'Closed',
  '失败': 'Failed',
  '被阻塞（旧数据）': 'Blocked (legacy data)',
  '已取消': 'Cancelled',
  '已中断（旧数据）': 'Interrupted (legacy data)',
  '任务回执': 'Task receipts',
  '已验收': 'Accepted',
  '已驳回': 'Rejected',
  '已忽略': 'Dismissed',
  'Prompt 快照（复制时的内容）': 'Prompt snapshot (content at copy time)',
  '此面板展示回执与验收操作；执行过程由 Agent 通过 MCP 工具回报。':
    'This panel shows receipts and review actions; the agent reports progress through MCP tools.',
  '计时会一直走下去；若 Agent 已停止工作但未回报完成，可手动收口。':
    'The timer keeps running; if the agent stopped without reporting completion, close it manually.',
  '全部通过': 'Approve all',
  '驳回原因（写回节点备注）': 'Rejection reason (written to node notes)',

  // ── 文档选择器 ──
  '全部文档': 'All documents',
  '选择文档': 'Select document',
  '统计范围：{path}{name}': 'Scope: {path}{name}',
  '搜索文档…': 'Search documents…',
  '搜索文档': 'Search documents',
  '清空搜索': 'Clear search',
  '文档列表': 'Document list',
  '没有匹配的文档': 'No matching documents',
  '{n} 个匹配': '{n} matches',
  '↑↓ 选择 · ↵ 确认 · Esc 关闭': '↑↓ select · ↵ confirm · Esc close',

  // ── 平铺视图 ──
  '标记为待处理': 'Mark as pending',
  '标记为已完成': 'Mark as completed',
  '没有待处理的叶子节点，去树里看看吧': 'No pending leaf tasks. Take a look at the tree',
  '树还是空的，去创建第一个任务': 'The tree is empty. Create your first task',
  '还没有已完成的任务': 'No completed tasks yet',

  // ── 统计视图 ──
  '按任务线查看叶子完成进度与最近 7 天完成量':
    'Leaf completion by task line and completions in the last 7 days',
  '叶子总数': 'Total leaves',
  '{pending} 待处理 · {done} 已完成': '{pending} pending · {done} completed',
  '完成率': 'Completion rate',
  '最近 7 天完成': 'Completed in last 7 days',
  '叶子节点': 'Leaf tasks',
  '还没有任务线，去树里创建第一个任务吧':
    'No task lines yet. Create your first task in the tree',
  '{n} 待处理': '{n} pending',
  '{n} 已完成': '{n} completed',
  '本周 +{n}': '+{n} this week',

  // ── 回收站视图 ──
  '删除的文档或目录保留在这里，可随时整体恢复；「彻底删除」后数据不可恢复':
    'Deleted documents and folders are kept here and can be restored at any time. "Delete permanently" cannot be undone.',
  '清空回收站': 'Empty Trash',
  '清空': 'Empty',
  '清空回收站？回收站内的文档与目录将被永久删除，不可恢复。':
    'Empty Trash? Documents and folders in the Trash will be permanently deleted and cannot be recovered.',
  '回收站是空的': 'Trash is empty',
  '删除于 {time}': 'Deleted {time}',
  '{n} 个子目录': '{n} subfolders',
  '恢复目录（含其中的文档）': 'Restore folder (with its documents)',
  '恢复文档到侧边栏': 'Restore document to sidebar',
  '彻底删除目录（含其中的文档，不可恢复）':
    'Permanently delete folder (with documents, irreversible)',
  '彻底删除文档（不可恢复）': 'Permanently delete document (irreversible)',
  '彻底删除': 'Delete permanently',

  // ── 总览 ──
  '统计的是当前仍存在的叶子任务的完成时间。父节点是分类，不计入；删除任务、或把文档移入回收站，会让对应日期的数字减少。回收站里的文档从恢复那一刻起重新计入。按当前时区划分日期，更换时区后历史会重新归位。':
    'Counts completion times of leaf tasks that still exist. Parent nodes are categories and never counted. Deleting tasks or moving documents to Trash reduces the numbers for those dates. Restored documents count again from the moment they are restored. Dates follow the current time zone and are re-bucketed if the time zone changes.',
  '「{name}」的叶子任务完成记录 · 不含回收站':
    'Leaf completion history for "{name}" · excluding Trash',
  '全部文档的叶子任务完成记录 · 不含回收站':
    'Leaf completion history for all documents · excluding Trash',
  '统计范围': 'Scope',
  '时间范围': 'Time range',
  '近 12 个月': 'Last 12 months',
  '{year} 年': '{year}',
  '范围内完成': 'Completed in range',
  '活跃天数': 'Active days',
  '当前连续': 'Current streak',
  '最长连续': 'Longest streak',
  '天': 'days',
  '数据读取失败：{error}': 'Failed to load data: {error}',
  '正在同步历史数据…': 'Syncing history…',
  '完成记录': 'Completion history',
  '{n} 个任务': '{n} tasks',
  '完成第一个任务后，这里会亮起第一格。':
    'Complete your first task and the first cell will light up.',
  '只看「当前仍存在」的叶子任务：父节点是分类，永不计数。文档进回收站后其完成记录一并移出，恢复后重新计入。':
    'Only "currently existing" leaf tasks are counted; parent nodes are categories and never counted. Documents in Trash are excluded and counted again after restore.',

  // ── 热力图 ──
  '正在读取完成记录…': 'Loading completion history…',
  '日历热力图：每格是一天，颜色越深完成的任务越多':
    'Calendar heatmap: each cell is a day; darker means more completed tasks',
  '少': 'Less',
  '多': 'More',
  '{n} 个': '{n}',
  '1–{n} 个': '1–{n}',
  '{a}–{b} 个': '{a}–{b}',
  '≥ {n} 个': '≥ {n}',
  '按本地 00:00 分日': 'Days split at local 00:00',
  '{date}，完成 {n} 个任务': '{date}, {n} tasks completed',
  '点击查看明细': 'click for details',
  '1月': 'Jan',
  '2月': 'Feb',
  '3月': 'Mar',
  '4月': 'Apr',
  '5月': 'May',
  '6月': 'Jun',
  '7月': 'Jul',
  '8月': 'Aug',
  '9月': 'Sep',
  '10月': 'Oct',
  '11月': 'Nov',
  '12月': 'Dec',

  // ── 当日明细 ──
  '选择一天': 'Select a day',
  '完成 {n} 个叶子任务': '{n} leaf tasks completed',
  '这天没有完成记录': 'No completions on this day',
  '勾选一个叶子任务，这里就会亮起来':
    'Check a leaf task and it will show up here',
  '在「{name}」中定位': 'Locate in "{name}"',
  '只统计当前仍存在的叶子任务；删除任务或把文档移入回收站，对应数字会减少。':
    'Only existing leaf tasks are counted; deleting tasks or moving documents to Trash reduces the numbers.',

  // ── 设置 ──
  '外观、Prompt 约束、MCP 集成与数据维护。':
    'Appearance, Prompt constraints, MCP integration, and data maintenance.',
  '外观、语言、Prompt 约束、MCP 集成与数据维护。':
    'Appearance, language, Prompt constraints, MCP integration, and data maintenance.',
  '外观': 'Appearance',
  '跟随系统': 'System',
  '浅色': 'Light',
  '深色': 'Dark',
  '通用 JSON': 'Generic JSON',
  '语言': 'Language',
  '界面语言': 'Interface language',
  '安装后默认按系统时区选择；可随时在这里切换。':
    'Defaults to your system time zone; you can switch anytime.',
  '「约束」段': '"Constraints" section',
  '复制 Prompt（纯文本 / 带回执）时附在末尾，两个变体共用。每行一条，复制时自动加上「- 」前缀；清空后保存等于恢复默认。':
    'Appended to both Copy Prompt variants. One item per line; "- " is added automatically. Saving an empty value restores the default.',
  '每行一条约束': 'One constraint per line',
  '保存约束': 'Save constraints',
  '恢复默认': 'Reset to default',
  '约束最多 {n} 个字符': 'Constraints can contain at most {n} characters',
  '约束已保存，下次复制 Prompt 生效':
    'Constraints saved; effective next time you copy a Prompt',
  '已恢复默认约束': 'Default constraints restored',
  'MCP 集成': 'MCP integration',
  '服务运行中 · {url}': 'Server running · {url}',
  '服务未启动（端口被占用）': 'Server not running (port in use)',
  '服务已关闭': 'MCP disabled',
  'MCP 服务已开启': 'MCP server enabled',
  'MCP 服务已关闭': 'MCP server disabled',
  'MCP 服务已关闭时，复制 Prompt（带回执）仍然可用，但 Agent 不会回写执行状态。':
    'With the MCP server disabled, Copy Prompt (with receipt) still works, but agents cannot report execution status.',
  '启用 MCP 服务': 'Enable MCP server',
  '默认开启；关闭后本地 MCP 服务会停止，Agent 无法回写执行状态。':
    'Enabled by default; turning it off stops the local MCP server, so agents cannot report execution status.',
  '三步接入：': 'Three steps:',
  '选目标 Agent，复制下方的 MCP 配置，粘贴进 Agent 的 MCP 设置':
    "Choose a target agent, copy the MCP config below, and paste it into the agent's MCP settings",
  '在 tree-todo 里右键「复制 Prompt（带回执）」，粘贴给 Agent':
    'In tree-todo, right-click "Copy Prompt (with receipt)" and paste it to the agent',
  'Agent 开始执行 / 完成时会自动回报，任务节点亮「执行中 / 待验收」':
    'The agent reports start/completion automatically, and task nodes show "Running / Awaiting review"',
  '复制 MCP 配置': 'Copy MCP config',
  '重置 token': 'Reset token',
  'token 只在本机回写执行状态（待验收 / 计时），任务完成与否永远由你在 tree-todo 里验收。':
    'The token only reports execution status locally (review/timing); you always verify completion in tree-todo.',
  'MCP 配置已复制，粘贴到 Agent 的 MCP 设置里即可':
    "MCP config copied. Paste it into your agent's MCP settings.",
  'token 已重置；已配置的 Agent 需要更新配置':
    'Token reset. Reconfigure any agents already set up.',
  '重置失败': 'Failed to reset token',
  '读取 MCP 配置失败': 'Failed to load MCP config',
  '读取设置失败': 'Failed to load settings',
  '自动清理删除超过': 'Auto-remove items deleted more than',
  '天的内容': 'days ago',
  '回收站里的文档与目录会在启动时和运行期间自动清理；填 0 表示不自动清理。':
    'Documents and folders in Trash are cleaned up at startup and periodically. Use 0 to disable.',
  '保留天数需在 0–3650 之间（0 表示不自动清理）':
    'Retention must be between 0 and 3650 days (0 disables auto-cleanup)',
  '已关闭回收站自动清理': 'Trash auto-cleanup disabled',
  '回收站将自动清理删除超过 {n} 天的内容':
    'Trash will auto-remove items deleted more than {n} days ago',
  '清理失败': 'Failed to clean up',
  '清空执行历史': 'Clear run history',
  '清理 7 天前': 'Remove older than 7 days',
  '待验收的记录不会被清除。': 'Records awaiting review will not be removed.',
  '已清理 {n} 条运行记录': 'Removed {n} run records',
  '没有可清理的记录': 'Nothing to clean up',
  '数据': 'Data',
  '文档结构版本：schema v4（执行状态 + 运行账本）':
    'Data schema: v4 (execution state + run ledger)',
  '迁移前自动备份到 app_data/backups/v4，失败不会覆盖原文件。':
    'Automatically backed up to app_data/backups/v4 before migration; failures never overwrite the original.',

  // ── 自动更新 ──
  '开发模式不检查更新': 'Update checks are disabled in development mode',
  '已是最新版本': "You're up to date",
  '检查更新失败，请检查网络后重试':
    'Failed to check for updates. Check your network and try again',
  '安装包校验失败，已取消更新':
    'Update signature verification failed; update cancelled',
  '网络连接失败': 'Network connection failed',
  '未知错误': 'Unknown error',
  '无法打开浏览器，请手动访问 GitHub Releases':
    'Could not open the browser. Please visit GitHub Releases manually',
  '没有待安装的更新，请重新检查': 'No pending update. Please check again',
  '发现新版本': 'Update available',
  '本次更新暂无说明。': 'No release notes for this update.',
  'macOS 版暂不支持应用内安装，将打开 GitHub Releases 下载页；Windows 版可直接下载安装。':
    "In-app installation isn't supported on macOS; the GitHub Releases page will open. Windows can install directly.",
  '有 {n} 个任务正在执行，更新会重启应用；执行记录会保留。':
    '{n} tasks are running. Updating will restart the app; run history will be kept.',
  '正在安装，应用即将重启…': 'Installing; the app will restart shortly…',
  '正在下载 {percent}% · {a} / {b}': 'Downloading {percent}% · {a} / {b}',
  '正在下载 · {size}': 'Downloading · {size}',
  '稍后': 'Later',
  '检查中…': 'Checking…',
  '下载中…': 'Downloading…',
  '安装中…': 'Installing…',
  '前往下载': 'Go to download',
  '立即更新': 'Update now',

  // ── 执行徽标 ──
  '排队中': 'Queued',
  '待确认 · {agent}': 'Awaiting confirmation · {agent}',
  '待验收 · {agent}': 'Awaiting review · {agent}',
  '失败 · {agent}': 'Failed · {agent}',
  '{agent} · 执行中': '{agent} · Running',
  '{agent} · 执行中 · {dur}': '{agent} · Running · {dur}',

  // ── 时间 ──
  '今天 {time}': 'Today {time}',
  '昨天 {time}': 'Yesterday {time}',
};

/** Rust AppError.code → 英文兜底文案（message 为中文细节，英文界面不直接展示）。 */
export const ERROR_CODE_EN: Record<string, string> = {
  Db: 'Database error',
  Io: 'File access error',
  NodeNotFound: 'Node not found',
  CyclicMove: 'Cannot move a node into its own subtree',
  ImportFormat: 'Invalid import file',
  LastDocument: 'At least one document must remain',
  RootProtected: 'The root task cannot be deleted',
  SchemaTooNew: 'This data was created by a newer version',
  Migration: 'Data migration failed',
  RunNotFound: 'Run not found',
};

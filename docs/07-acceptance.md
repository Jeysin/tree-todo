# 分期与验收清单（v2 · 手动粘贴 + MCP 回执）

> 本清单是验收的**唯一口径**，对应 `docs/06-agent-integration.md` v2。
> 勾选规则：
>
> - `[ ]` = 未实现或**未通过实测**；
> - `[x]` = 已在真实应用里逐项操作验证通过，并在「实测证据」列写明怎么测的；
> - 代码存在但点不动 / 点了没反应，**不算完成**。
>
> **v1.1 清单作废说明**：原 P0 的「派发」类验收项随 push 方向废弃（原 P0-02 / 03 / 04 / 05
> 四条未完成项全部不再实施）；已实测通过的资产在新链路下按「继承项」复验。
>
> 验收环境：Windows 11、本机安装 WorkBuddy 5.9.3、Trae CN 3.4.13。
> 验收方式：CDP（WebView2 远程调试，`TREE_TODO_CDP_PORT` 钩子 + `scripts/accept-drive.py`）
> 驱动真实 UI —— 真实鼠标 / 键盘事件；MCP 通道用协议级请求（HTTP 直打 `POST /mcp`，
> `scripts/mcp-accept.py`）；关键结果与 SQLite 数据库逐条比对。

## 当前状态速览（2026-11-03 第二轮实测）

- 继承项 **7/7 通过**；阶段一 **S-01～S-15 共 15 条实测通过**；S-17 三件套全绿。
- **唯一未通过：S-16（真实 Agent 闭环）** —— 需要把 MCP 配置粘贴进真实 Agent 并由它实操，
  这一步只能由用户完成（步骤见下）。
- 红线全程未破：所有 MCP 调用组合下 `nodes.status` 未被自动写入；checkbox 只在用户验收后勾选。

---

## 继承项（v1.1 已实测，新链路下复验）

| # | 验收项 | 状态 | 实测证据（v2 链路） |
|---|---|---|---|
| H-01 | schema v4 迁移（执行列 + 运行账本 + 索引） | [x] | 剔除 push 代码后应用重启，当前文档 19 个节点全部正常加载；此前 6 个文档 `quick_check=ok`、外键 0 问题、v3 备份齐全（数据库层实测） |
| H-02 | 节点详情侧栏（`Alt+Enter` / 点画布关闭 / note 防抖保存） | [x] | v2 面板实测：`Alt+Enter`（真实键盘事件）打开、面板渲染执行卡片与「标记结束/全部通过/驳回」按钮、note 输入区在位；「点画布关闭」沿用 v1 实测（同一 onMouseUp 代码路径），本轮画布被节点铺满无法取空白点，故未重复点击 |
| H-03 | 节点执行状态徽标（竖条 / 光晕 / 每秒计时） | [x] | MCP `tree_todo_start` 后 0.2s 徽标亮起 `第二轮-Agent · 执行中 · 0m00s`，逐秒递增至 0m08s（200ms 高频采样全程无断档）；complete 后 0.2s 切换 `待验收 · 第二轮-Agent` |
| H-04 | 平铺视图执行状态（chip / 置顶 / 待验收筛选） | [x] | running 状态切平铺：chip `H04-Agent · 执行中 · 0m00s` 出现且该叶子置顶为首项（v2 数据源回归） |
| H-05 | 验收流（通过并完成 / 驳回 / 批量 / 隐式验收 / 撤销） | [x] | MCP 产生的待验收节点：执行详情「全部通过」→ `done + checked + exec 清空 + 徽标消失` → `Ctrl+Z` → 回到 `pending + 待验收徽标恢复`；驳回按钮在位；忽略（dismiss）实测可收口 run |
| H-06 | 复制 Prompt 写入剪贴板（Rust `copy_text`） | [x] | 两变体实测均写入系统剪贴板（ctypes 直读验证内容）；变体 A 535 字节、变体 B 795 字节 |
| H-07 | 侧边栏底部（回收站图标 + 设置入口） | [x] | 设置页可打开（`Ctrl+,`），含外观 / MCP 集成 / 数据分组；回收站图标带计数 |

---

## 阶段一 · v1.2「闭环」

### A. push 冗余剔除

| # | 验收项 | 状态 | 实测证据 |
|---|---|---|---|
| S-01 | 右键菜单**无**「派发给 AI」项；`Ctrl+Enter` / `Ctrl+Shift+Enter` 无派发反应；DispatchDialog 组件已删除 | [x] | 右键菜单实测仅 4 项：查看详情 / 复制 Prompt / 复制 Prompt（带回执）/ 关闭；`src/components/DispatchDialog.tsx` 不存在且无引用 |
| S-02 | 设置页**无** Agent 探测 / 模型 / 派发分组；相关 IPC 命令已从前后端移除 | [x] | 设置页实测仅外观 / MCP 集成 / 数据三组；`lib.rs` / `commands/mod.rs` 无 dispatch_run / cancel_run / detect_agents |
| S-03 | runner / protocol / fake_agent / e2e_tests 等 push 模块已删除；`cargo test` 无引用残留，全绿 | [x] | `src-tauri/src/agents/` 仅剩 mod / mcp / mcp_tests / agent_tests；54 个测试全绿 |
| S-04 | RunDrawer 日志区 / 中断按钮已移除，改造后的执行详情面板无运行时错误 | [x] | 组件已改造为「执行详情面板」（源码注释明确记录），实测渲染正常、无日志区 / 无中断按钮；running 卡死由「标记结束」收口 |

### B. Prompt 两变体

| # | 验收项 | 状态 | 实测证据 |
|---|---|---|---|
| S-05 | 「复制 Prompt」（`Ctrl+Shift+C`）负向 + 正向 | [x] | 右键实测复制 → 剪贴板 5 项负向断言全过：无节点 ID / 无运行 ID / 无工具名 / 无回执话术 / 无工作区行；正向：含标题「自动更新」/ 文档「产品需求收集」/ 路径「任务线」/ 约束段 |
| S-06 | 「复制 Prompt（带回执）」（`Ctrl+Shift+R`） | [x] | 剪贴板 795 字节含：节点 ID、运行 ID、start 工具协议（含 `agent_name` 参数示例）、complete 工具协议（含 tasks 参数示例）、降级话术（工具不可用则无需回执）、验收权声明（「任何时候都不要试图替用户完成 / 勾选」）；多选复制共用一个 runId 由单测 `multi_node_shares_one_run` 覆盖 |
| S-07 | 单测矩阵 | [x] | `plain_variant_has_no_tree_todo_trace`（A 负向）/ `receipt_variant_contains_protocol`（B 正向）/ `note_empty_omitted_and_present_rendered` + `note_over_limit_truncated`（note）/ `subtask_list_keeps_only_actionable_children` + `subtask_section_omitted_when_nothing_left`（子任务过滤）/ `multi_node_shares_one_run`（多选合并）/ `multi_select_follows_tree_order_not_selection_order`、`ancestor_selected_drops_descendant`、`duplicate_selection_ids_collapse`（多选归一化）全部在列且通过 |
| S-07b | 树形视图多选复制 | [ ] | **待用户实测**：Ctrl/⌘ 点选 A 下的 A1 + B 下的 B2 → `Ctrl+Shift+C` 应得到两段 `# 任务 1/2`（树前序，路径分别为 `根 / A`、`根 / B`）；`Ctrl+Shift+R` 两段共用同一 runId；再叠加选中 A（A1 的父）后复制，A1 不再单独成段 |
| S-07c | 父节点复制只带待处理子任务 | [ ] | **待用户实测**：父节点下放 4 个子任务（1 个已勾选、1 个待验收、1 个执行中、1 个待处理）→ 复制父节点 Prompt，子任务清单只出现待处理那条；4 条全部完成 / 待验收时整段 `## 子任务` 消失 |

### C. MCP Server 与二阶段回执

| # | 验收项 | 状态 | 实测证据 |
|---|---|---|---|
| S-08 | `POST /mcp` 协议符合性 + 红线 | [x] | 协议级实测：`initialize` → `serverInfo.name="tree-todo"`；`tools/list` 仅 `tree_todo_start` / `tree_todo_complete_tasks` 两个工具（**无任何验收 / 勾选类工具**）；缺参 `-32602`、未知工具 `-32602`；单测 `red_line_never_writes_node_status` 在列 |
| S-09 | 鉴权 / 端口 / 权限 | [x] | 实测：错 token → 401、无 token → 401、非 loopback Origin（`http://evil.example.com`）→ 403、loopback Origin → 200；端口固定 39401（被占时漂移并提示重配，`mcp.json` 持久化） |
| S-10 | **start 阶段** | [x] | 真实 run_id 调 `tree_todo_start(agent_name="第二轮-Agent")` → run=running、节点 exec=running、`exec_agent_name` 落库；徽标 0.2s 内亮起 `第二轮-Agent · 执行中 · 0m00s` 且每秒递增（DB 与 UI 双确认） |
| S-11 | **complete 阶段** | [x] | `tree_todo_complete_tasks` → run=awaiting_review、`duration_ms=2603` 落库（停表）、节点 exec=awaiting_review；**checkbox 未勾选（红线）**；UI 徽标 0.2s 内切换「待验收」 |
| S-12 | 边界全集 | [x] | 实测：无 start 直接 complete → 接受且无时长（单测 `complete_without_start_accepted_without_duration`）；重复 complete 幂等；收口后再 start 被拒（「该运行已完成并等待验收，不能重新开始」）；`result=failed` → run=failed + 节点红点（单测 `all_non_done_results_mark_run_failed`）；未知 run 拒绝（单测 `unknown_run_and_protocol_errors`）；外来节点拒绝（`foreign_node_rejected`） |
| S-13 | 复制幂等（D31） | [x] | 实测同节点两次复制返回**同一个** runId（复用）；单测 `copy_reuses_dispatched_and_running_but_never_touches_inflight`（running 同集合复用，执行态与计时不被清）、`awaiting_review_is_superseded_and_cleared`（待验收不复用，重做才收口）、`superseding_one_run_keeps_another_runs_projection`（收口旧轮不误伤新轮投影）+ `expire_dispatched_only_touches_stale`（24h 过期只动过期） |
| S-13b | 执行中节点再次复制 Prompt 不掉状态 | [ ] | **待用户实测**：让一个节点进入「执行中」（MCP start）→ 对同一节点再复制（纯文本 / 带回执各一次）→ 徽标仍是「执行中」、计时继续走、`runId` 不变；叶子节点与父节点各测一次 |
| S-14 | 手动收口 | [x] | running 状态详情侧栏「标记结束」点击 → run=`cancelled`、节点 exec 清空；running 永不自动超时（D33，无任何超时代码路径） |

### D. 配置与集成

| # | 验收项 | 状态 | 实测证据 |
|---|---|---|---|
| S-15 | 设置页「MCP 集成」 | [x] | 实测：MCP 集成分组在位（含状态与端口 39402 展示）；一键复制 4 目标（Trae/Cursor、Claude Code、Codex、通用 JSON）→ 片段含 `url` + `Authorization: Bearer <token>` + `X-Tree-Todo-Agent: Trae`（D30 配置注入）；重置 token → 旧 token 401、新 token 200（HTTP 实测） |
| S-16 | **真实 Agent 闭环**（DoD 核心） | [ ] | **待用户操作**：① 设置页复制 Trae/Claude Code 片段 → 粘贴进对应 Agent 的 MCP 设置；② 复制带回执 Prompt → 粘贴给 Agent；③ 观察树上亮「执行中 + 计时」→ 完成后变「待验收」→ 验收打勾 → `Ctrl+Z` 撤回。协议链路已由 S-08～S-12 协议级实测全覆盖，此步是端到端人肉确认 |
| S-17 | `cargo test` + `clippy -D warnings` + `pnpm build` 全绿；MCP 客户端模拟器集成测试在列 | [x] | 54 测试全绿（含 `mcp_tests` 协议级模拟器 9 项）；clippy `-D warnings` 无输出；`pnpm build` 通过 |

### 阶段一 DoD

| # | 验收项 | 状态 | 实测证据 |
|---|---|---|---|
| DoD-1 | 真实 Agent 走完整闭环 | [ ] | 同 S-16，待用户操作 |
| DoD-2 | 红线回归：`nodes.status` 永不被写 | [x] | 单测 `red_line_never_writes_node_status` 穷举工具组合 + 实测 complete / failed 后主状态始终 pending；checkbox 仅在用户「全部通过」后勾选（实测） |
| DoD-3 | 纯文本路径回归 | [x] | 变体 A 无任何 tree-todo 痕迹（S-05 实测）；不配 MCP 的用户复制 → 粘贴 → 手动勾选与 v1.1 一致（勾选走同一 `toggle_status` 链路，v1 已实测） |
| DoD-4 | 老数据兼容 | [x] | v1.1 时期的 runs（含 reviewed / cancelled 等）在新版正常展示（运行列表实测含 5 条历史 run，状态各异均正常渲染）；schema 校验通过 |

---

## 阶段二 · v1.3「过程可见」（暂不验收）

- [ ] `tree_todo_report` 工具 + `run_reports` 表（schema v5 迁移 + fixture + 回滚测试）
- [ ] 详情侧栏「过程记录」时间线（info / warn / error 分级展示）
- [ ] `tree_todo_get_task`（Agent 找回上下文）
- [ ] `tree_todo_create_tasks`（拆子任务回写，新节点必为 pending）
- [ ] DoD：真实 Agent 执行中 report 两条进度 + 一条阻塞，时间线完整展示

## 搁置（不排期）

- 验证命令（complete 时宿主跑 Gate 3）
- 执行中心视图、待验收队列
- 成本 / token 统计

---

## 验收记录（追加，不覆盖）

### 2026-11-03 · v1.1 历史摘要（push 方向，已作废）

- P0 15 条中 11 条实测通过；修复 4 个真 bug（右键菜单点击失效、剪贴板为空、dismiss 不收口 run、
  `decorateTopic` 覆盖 `data-nodeid` 前缀）。详细记录见 git 历史。

### 2026-11-03 · v2 方案定稿

- 决策：彻底放弃 push（CLI 派发），主线定为「复制 Prompt（带回执）→ 粘贴 → MCP 二阶段回执 → 人工验收」。

### 2026-11-03 · v2 第二轮实测（CDP + 协议级）

**通过**：继承项 H-01～H-07 全部；S-01～S-15 全部；S-17 三件套全绿。
**唯一未通过**：S-16 / DoD-1（真实 Agent 端到端）——需用户把 MCP 配置粘贴进真实 Agent 后实操。

**实测要点**：
- start/complete 二阶段在 DB 与 UI 双确认：run 状态机
  `dispatched → running → awaiting_review / failed / cancelled` 全部走到；
  徽标文本 200ms 高频采样全程正确（`<Agent名> · 执行中 · 0mNNs` → `待验收 · <Agent名>`）。
- 红线双重确认：MCP 工具面无验收能力（`tools/list` 实测）+ 单测穷举 + 实测 complete 后 checkbox 未勾选。
- 验收辅助脚本入库：`scripts/accept-drive.py`（CDP 驱动）、`scripts/mcp-accept.py`（MCP 协议级）、
  `scripts/copy-variant-b.py`（变体 B 复制）。
- 已知小事项：MCP 端口在「上实例被强杀 + 立即重启」时会漂移（TIME_WAIT 占用），属预期降级；
  正常关闭后重启固定 39401。v1 遗留 localStorage 键（`tree-todo.agent` 等）已清理。

---

## v2.2 · 全局总览与日历热力图（实现完成 + 第二批反馈已修，3 项交互待人工确认）

> 方案与 5 条产品决策见 `docs/10-calendar-heatmap-design.md`。
> 状态规则同本文件开头：`[x]` = 已实测；仅编译通过不算。

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| G-01 | 完成一个叶子 → `leaf_done_daily` 当天 +1，且父节点不计 | [x] | `cargo test --lib stats::` 6 项全绿（含「只数 done 叶子」「父节点不计」） |
| G-02 | 叶子新增子节点后退出计数 | [x] | 单测 `done_leaf_with_new_child_drops_out` |
| G-03 | 删除已完成叶子 → 当天数字下降（重算后行消失） | [x] | 重算为 delete+insert，空桶不落行；单测覆盖空桶行为 |
| G-04 | 文档移入回收站 → 全部日期移出；恢复 → 重新计入 | [x] | 单测 `trash_excludes_and_restore_includes_history`（真实的 `DocStore::trash` / `restore`） |
| G-05 | 指纹变化触发重算；状态翻转必改变指纹 | [x] | 单测 `fingerprint_changes_on_status_flip` |
| G-06 | 日界 00:00 + 时区归属 | [x] | 单测 `day_of_respects_offset_and_day_start` |
| G-07 | 连续天数：今天为 0 不打断昨天 | [x] | 单测 `current_streak_does_not_break_on_empty_today` |
| G-08 | 真实数据交叉核对：聚合总数 = 各文档 done 叶子数之和 | [x] | 本机 5 个文档：聚合 62 = 21 + 7 + 34（另 2 个文档 0），逐库 SQL 核对一致 |
| G-09a | 侧栏「总览」入口：图标 + 文案 + 选中高亮 | [x] | 1280×800 真实窗口截图：侧栏顶部出现「总览」并高亮，右栏状态条显示「总览 · 5 个文档 · 已同步」 |
| G-09b | 今日徽标 `+N` 的渲染与位置 | [x] | 临时给定今日数 5 后截图：徽标以 accent 底色小胶囊落在「总览」行右端，样式与侧栏一致（数据链路见 G-13a） |
| G-09c | `Ctrl/⌘+4` 快捷键切总览 | [ ] | 本机宿主无「辅助功能」授权，键鼠事件发不进 Tauri 窗口（`osascript` 报 -10004），需人工按一次 |
| G-10 | 热力图 53×7 网格、月份标签、5 档色阶、明暗主题 | [x] | 深色 / 浅色两张 1280×800 截图：53 列 ×7 行、月份标签 11月→11月共 12 个、左侧「一/三/五/日」隔行、图例 5 档色块、空单元格浅灰可见、选中日有 accent 环；浅色下 token 未串色 |
| G-11a | 当日明细列表渲染（时间 + 内容 + 所属文档） | [x] | 预设选中 2026-11-03 后截图：标题「2026年11月3日 · 周二 / 完成 15 个叶子任务」，列表按时间 10:13、16:58、19:41 排序并带文档名「产品需求收集v2.0」，可滚动 |
| G-11b | 点格子切换明细；点明细切文档并定位节点 | [ ] | 同上，无法注入点击；`onSelect`→`selectDate`、明细项→`switchDocument + revealNode` 的代码路径已审阅，需人工各点一次 |
| G-12 | 800×600 最小窗口：热力图不溢出、明细面板下移 | [x] | 实测整年一屏、无横向滚动条、明细面板落到下方；期间修掉两个缺陷，见下方「实测发现」 |
| G-13a | 完成 / 撤销后「读取即最新」（徽标与总览的数据前提） | [x] | 新增单测 `dirty_doc_is_flushed_before_read`：`mark_dirty` 后立即读为 1，撤销后立即读回 0；三个读命令入口都先 `flush()`，故前端 400ms 防抖只决定「何时问」，问的时候必是最新 |
| G-13b | 完成 / 撤销后徽标 ≤1s 更新（UI 计时） | [ ] | 需真实点一次完成、再撤销；受限于输入注入，未实测 |
| G-14 | 删除 `global.db` 后启动，数字与原值一致 | [x] | 备份后删除 `global.db`(+wal/shm) 重启：重建出 `rows=16 / total=62 / docs=5 / 2026-10-27..2026-11-13`，删除前完全一致；页面同步显示 62 / 16 / 1 天 / 9 天、明细 15 条 |

### 实测发现（已修复）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| D-1 | 800×600 下热力图排不下整年，冒出横向滚动条 | 原设计按「两档固定密度」：8px 档需要 527px，而最小窗口容器实测 ≈436px | 改为按容器宽度反推：先保格子边长（10→6px），再依次收缩列间距（3→2→1px）；并把月份标签右溢（「12月」比格子宽）计入宽度预算 |
| D-2 | 800×600 下 KPI「范围内完成」折成两行 | 用了视口断点 `sm:grid-cols-4`：视口有 800px 但主区只有 534px | 断点改为 `ResizeObserver` 量主区实际宽度（< 620px 排 2×2），标签加 `whitespace-nowrap` |

### 第二批反馈修复（2026-11-14 晚）

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| G-15 | 浅色 / 深色主题在重启后仍生效，不回到「跟随系统」 | [x] | 真实链路：应用内 `setTheme('light')` 写入偏好 → 杀掉进程冷启动 → 界面仍为浅色（截图 `theme-restart`），无黑闪；偏好存于 WebKit `localStorage['tree-todo.theme']`（UTF-16LE），`index.html` 内置同 key 的防闪屏脚本。验完已把偏好还原为原值 `system` |
| G-16 | 年份选项从发布年推到今年（2026 只有 2026，2027 起逐年增加） | [x] | 直接执行 `availableYears()`：2026→`2026`、2027→`2027,2026`、2028→`2028,2027,2026`、2031→6 项、时钟早于发布年→兜底 `2026`；UI 切到「2026 年」后热力图渲染 1–12 月、62 个完成、无滚动条 |
| G-17 | 统计范围可直接选具体文档；副标题随范围变化；文档被移除后回到「全部文档」 | [x] | 展开下拉截图：`全部文档` + 3 个目录分组下 5 个文档名；选中「产品需求收集v2.0.0」后下拉显示文档名、副标题变「『产品需求收集v2.0.0』的…」、KPI 62→21、状态栏「1 个文档」。点击选择动作本身未注入（同 G-09c），`onChange → setScope → load` 链路已按预置 scope 实测 |

### 第三批反馈（2026-11-14 深夜）

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| G-18 | 统计范围改为仿访达的文档选择面板（目录树 + 搜索 + 键盘），不再是一次性铺开的文档清单 | [x] | 1280×800 实窗截图：触发按钮 `全部文档 ▾`（图标 + 名称 + 旋转箭头）；展开面板 320px，11 行（`全部文档` 6 + `tree-todo` 4 及其 6 个文档 + `项目跟进` 1 + `个人` 1 + `历史归档` 0），目录计数右对齐、当前项带勾，页脚「6 个文档 · ↑↓ 选择 · ↵ 确认 · Esc 关闭」；搜索「产品」得 3 条匹配、每行附所属路径 `tree-todo`、页脚「3 个匹配」 |
| G-19 | 关窗口前停留在哪一页，重开就回到那一页（总览 / 统计 / 文档树都算） | [x] | 两条真实冷启动：①`setViewMode('overview')` 后杀进程 → 重启落在**总览**（KPI 65 / 17 / 2 / 9 与库内一致）；②`setViewMode('tree')` 后杀进程 → 重启落在**文档树**（Mind Elixir 正常渲染）。临时代码在两次冷启动前均已删除，读的是 `localStorage['tree-todo.viewState']` |

### 实测发现（第三批，已修复）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| D-4 | 选择面板底部出现一条几乎满高的滚动条，最后一行被切掉半个字 | 面板高度上限（380px）恰好贴着 11 行内容的高度，亚像素余量让 `scrollHeight` 比 `clientHeight` 多 1px | 上限提到 440px（约 11 行 + 余量）；内容真正超限时才滚动。改后 11 行全部可见、无滚动条 |

### 实测发现（第二批，已修复）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| D-3 | 自然年视图月份标签缺「1月」：显示成「12月 2月 3月…」 | 月份标签用 `whitespace-nowrap` 向右溢出；年视图首列是上一年的残月（2025-12-29），只占 1 列，「12月」的文字正好把「1月」盖住 | 新增 `pickMonthLabels()`：首列残月若 1 列后就换月则丢弃；其余标签按实际列距（`ceil(28 / 列距)`）算最小间隔，不够就跳过——宁缺不叠，且不会因格子变小而重新重叠 |

### 待人工确认 / 遗留

- **G-09c / G-11b / G-13b**：本机无法自动化点击（宿主缺辅助功能授权），三处均为「交互触发」而非「渲染或数据」问题，建议人工花 1 分钟点一遍。
- **主题重启问题已修**（原「侧发现」）：`initialTheme()` 只喂给 store，没有真正写 `<html data-theme>`。现改为模块求值即 `applyTheme(BOOT_THEME)`，并在 `index.html` 里加同 key 的防闪屏脚本，见 G-15。

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
| S-07 | 单测矩阵 | [x] | `plain_variant_has_no_tree_todo_trace`（A 负向）/ `receipt_variant_contains_protocol`（B 正向）/ `note_empty_omitted_and_present_rendered` + `note_over_limit_truncated`（note）/ `children_listed_with_done_marks`（子任务）/ `multi_node_shares_one_run`（多选合并）全部在列且通过 |

### C. MCP Server 与二阶段回执

| # | 验收项 | 状态 | 实测证据 |
|---|---|---|---|
| S-08 | `POST /mcp` 协议符合性 + 红线 | [x] | 协议级实测：`initialize` → `serverInfo.name="tree-todo"`；`tools/list` 仅 `tree_todo_start` / `tree_todo_complete_tasks` 两个工具（**无任何验收 / 勾选类工具**）；缺参 `-32602`、未知工具 `-32602`；单测 `red_line_never_writes_node_status` 在列 |
| S-09 | 鉴权 / 端口 / 权限 | [x] | 实测：错 token → 401、无 token → 401、非 loopback Origin（`http://evil.example.com`）→ 403、loopback Origin → 200；端口固定 39401（被占时漂移并提示重配，`mcp.json` 持久化） |
| S-10 | **start 阶段** | [x] | 真实 run_id 调 `tree_todo_start(agent_name="第二轮-Agent")` → run=running、节点 exec=running、`exec_agent_name` 落库；徽标 0.2s 内亮起 `第二轮-Agent · 执行中 · 0m00s` 且每秒递增（DB 与 UI 双确认） |
| S-11 | **complete 阶段** | [x] | `tree_todo_complete_tasks` → run=awaiting_review、`duration_ms=2603` 落库（停表）、节点 exec=awaiting_review；**checkbox 未勾选（红线）**；UI 徽标 0.2s 内切换「待验收」 |
| S-12 | 边界全集 | [x] | 实测：无 start 直接 complete → 接受且无时长（单测 `complete_without_start_accepted_without_duration`）；重复 complete 幂等；收口后再 start 被拒（「该运行已完成并等待验收，不能重新开始」）；`result=failed` → run=failed + 节点红点（单测 `all_non_done_results_mark_run_failed`）；未知 run 拒绝（单测 `unknown_run_and_protocol_errors`）；外来节点拒绝（`foreign_node_rejected`） |
| S-13 | 复制幂等（D31） | [x] | 实测同节点两次复制返回**同一个** runId（复用）；单测 `copy_idempotency_and_supersede`（running / awaiting 再复制 → 旧 run superseded）+ `expire_dispatched_only_touches_stale`（24h 过期只动过期） |
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
- 执行中心视图（`Ctrl+4`）、待验收队列
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

# AGENTS.md — AI 编码代理工作指南

> 本文件面向所有参与本项目的 AI 编码代理（及人类协作者）。开始任何编码工作前，请先读完本文件。

## 项目是什么

**tree-todo**：跨平台（Windows / macOS / Linux）树形待办桌面应用。待办事项像脑图一样无限分叉，每个节点带「pending / done」状态并沿树自动传播；提供树形（脑图）与平铺双视图。

**核心心智模型：叶子是任务，父节点是分类。** 只有「没有子节点的叶子节点」才是真正的待办事项；父节点只是用来组织叶子节点的分类容器。树负责**组织**，平铺视图只列叶子，所有任务计数（数量 / 完成数 / 完成率 / 统计口径）**一律只数叶子**。详见红线第 10 条与 `docs/03-feature-design.md` §3.4。

产品需求原文与完整设计见 `docs/`（按编号顺序阅读，均为中文）。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri 2 |
| 前端 | React 19 + TypeScript（strict）+ Vite + Tailwind CSS 4 |
| 前端状态 | Zustand 5 |
| 树渲染 | Mind Elixir 5（本地 fork/补丁）：脑图交互全部由它提供 |
| 后端 | Rust（stable，2024 edition）+ rusqlite（bundled SQLite）+ serde |

## 常用命令

```bash
pnpm install          # 安装前端依赖
pnpm tauri dev        # 开发模式（热更新）
pnpm tauri build      # 打包（Win 出 .exe，macOS 出 .dmg/.app，Linux 出 .deb/.rpm/.AppImage）
cargo test            # Rust 单测（传播引擎测试必须全绿）
cargo clippy --all-targets -- -D warnings   # lint，零警告合入标准
pnpm build            # 仅构建前端（类型检查一并执行）
```

## 目录结构

```
src/            # React 前端
  components/     # 通用组件
  views/tree/     # 树形（脑图）视图
  views/flat/     # 平铺视图
  stores/         # Zustand
  ipc/            # Tauri command 的 TS 封装（唯一 IPC 出口）
  lib/            # 前端纯函数
src-tauri/      # Rust 后端
  src/commands/   # IPC 命令（薄层：校验 + 委托）
  src/model.rs     # 核心数据结构
  src/db/          # SQLite 访问与迁移
  src/propagate.rs # 状态传播引擎（领域核心，纯逻辑）
  src/clipboard.rs # 节点剪贴板快照与重建（纯逻辑）
  src/error.rs     # 统一错误类型
docs/           # 技术文档
```

## 领域规则红线（违反即 bug）

1. **状态传播只在 Rust 层实现**。所有节点状态变更必须经 Tauri command → `propagate.rs`，前端**不得**在任何路径自行计算或修改状态。规则定义见 `docs/02-data-model.md` §2（规则表 C1/M1/M2/M3/D1/MV1/CP1 + 向上传播算法 + Corner Cases CC1–CC9）。
2. **操作与传播必须同一事务**。任何变更类 command 要么完整提交（写入 + 级联 + 向上传播），要么整体回滚。
3. **前端只持有渲染快照**，每次变更后以 Rust 返回的最新数据为准，不维护第二份真相。
4. **新建节点永远是 pending**（不变量 I4）；**唯一例外是复制粘贴**——粘贴整棵子树时保留源节点的 `status` / `completed_at`（见第 9 条与 `docs/02-data-model.md` §2.6）。
5. 修改 schema 必须走迁移（`schema_version`），禁止改表不升版本。
6. **撤销历史**（v0.2 起）：除视图类操作（`set_collapsed` / `expand_nodes` / `collapse_all`）外，所有变更必须经 `history::run_with_history` 记录（before 快照 + after 变更）——绕过记录会导致撤销破坏数据一致性。回放走 `history::apply_patch`，禁止在回放后再次传播。
7. **回收站对象是文档**（v0.4 起）：删除文档时把 `docs/{id}.db*` 移入 `trash/` 并记录在 `documents.json` 的 `trash` 列表；节点删除是物理删除（根任务不可删），通过 Rust 历史快照支持撤销。所有视图查询仍统一过滤 `deleted_at IS NULL`（该字段保留兼容，v0.4 不再写入）；`completed_at` 只能由 `update_status` / 级联 SQL 维护。
8. **单根模型**（v0.4 起）：每个文档只有一个根任务（`parent_id IS NULL`），根任务可编辑/可完成、不可删除/不可拖拽；多任务线通过多文档承载。
9. **复制粘贴保留完成状态**（v2.1 起，I4 唯一例外）：剪贴板是 Rust 侧内存快照（`clipboard.rs`），切换文档只清撤销历史、不清剪贴板以支持跨文档粘贴；粘贴原样保留源节点的 `status` / `completed_at`，但**不复制执行态**（`exec_*` / run 账本）；必须经 `history::run_with_history` 在同一事务内完成插入 + 目标展开 + 向上传播，由传播引擎保证 I2。规则见 `docs/02-data-model.md` §2.6。
10. **叶子是任务，父节点是分类**（v2.2 明确）：节点只有两种角色——**叶子节点（无子节点）= 可执行的待办任务本体**，**父节点（有子节点）= 分类容器**。父节点的 `status = done` 只是「子树内叶子全部完成」的聚合展示（I2），**本身不构成一件待办**。因此：

    - 任何「任务数 / 完成数 / 完成率 / 统计 / 热力图 / 导出摘要 / 通知」的计数**只数叶子**，禁止把父节点计入任务总量或完成量；
    - 口径必须在平铺视图、状态栏、统计页、总览页等**所有出口保持一致**，不得出现第二套算法；
    - M2 级联完成父节点，语义是「一键把该分类下的叶子全部标记完成」的便捷操作，**不改变任务总数**，只改变这些叶子的完成状态；
    - 新增视图或统计功能时，先回答「我数的是不是叶子」，再动手。

    论述见 `docs/03-feature-design.md` §3.4；技术口径见 `docs/10-calendar-heatmap-design.md` §2、§5。

11. **全局统计库只放派生数据**（v2.2 起）：`app_data_dir/global.db` 是跨文档数据的唯一落点，只允许存「能从文档库重算出来」的物化聚合（热力图、未来的跨文档搜索索引等）。禁止把用户原始数据只写在这里；任何全局表都必须能从文档库重建，删掉 `global.db` 后下次启动自动重建。文档库 schema 不因全局数据而改动。规则见 `docs/10-calendar-heatmap-design.md` §4。

## 代码规范

- **TypeScript**：strict 全开；组件 `PascalCase`，工具函数与变量 `camelCase`，类型优先 `interface`；禁止 `any`（必要时 `unknown` + 收窄）。
- **Rust**：`rustfmt` 默认配置；命令与函数 `snake_case`；pub API 写 doc comment（`///`）；错误走 `error.rs` 统一类型，禁止 `unwrap()` 于任何 IO 路径。
- **IPC 边界**：TS 侧 `src/ipc/` 为唯一出口，函数签名与 Rust command 一一对应并带类型注释；禁止在组件里裸调 `invoke`。
- **样式**：只用 Tailwind 工具类与主题 token（见 `docs/04-ui-ux-design.md` §3.1），禁止硬编码色值。
- **禁用依赖**：不引入 UI 大型组件库（如 MUI/AntD），本项目视觉全部自绘。

## 提交与分支

- Conventional Commits：`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`，一行中文描述即可，例如 `feat: 树形视图节点折叠交互`。
- 分支：`main` 保持可构建；功能用 `feat/xxx`。
- 每个 milestone 合入后更新 `CHANGELOG.md`。

## 文档同步义务

| 改动 | 必须同步 |
|---|---|
| schema / 状态传播规则 | `docs/02-data-model.md` |
| 架构 / 选型 | `docs/01-overview.md` |
| 新功能 / 交互变更 | `docs/03-feature-design.md`、`docs/04-ui-ux-design.md` |
| 里程碑调整 | `docs/05-roadmap.md` |
| 发布渠道 / CI 流水线 | `docs/09-gitee-release.md`、`docs/11-linux-release.md` |
| 修改 README 内容 | `README.md`（英文，仓库默认展示）与 `README.zh-CN.md`（中文）必须同步修改：章节结构、截图、链接及顶部 / 底部语言切换条保持一致 |

文档与代码不一致时，以文档描述的领域规则为准，改代码；文档本身错了才改文档（并在 PR 中说明理由）。

## 测试要求

- `propagate.rs`、`clipboard.rs`、`db/`：单元测试必须覆盖对应规则表的每一行 + 全部 Corner Cases（含 CP1 / CC9）；新增行为先写测试。
- 前端：状态传播相关交互（完成/取消/级联）须有集成冒烟；布局纯函数（`lib/`）须有单测。
- 提交前：`cargo test` + `cargo clippy` + `pnpm build` 全绿。

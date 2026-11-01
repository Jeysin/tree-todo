# AGENTS.md — AI 编码代理工作指南

> 本文件面向所有参与本项目的 AI 编码代理（及人类协作者）。开始任何编码工作前，请先读完本文件。

## 项目是什么

**tree-todo**：跨平台（Windows / macOS）树形待办桌面应用。待办事项像脑图一样无限分叉，每个节点带「pending / done」状态并沿树自动传播；提供树形（脑图）与平铺双视图。

产品需求原文与完整设计见 `docs/`（按编号顺序阅读，均为中文）。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri 2 |
| 前端 | React 19 + TypeScript（strict）+ Vite + Tailwind CSS 4 |
| 前端状态 | Zustand 5 |
| 树渲染 | @xyflow/react（画布）+ d3-hierarchy（布局） |
| 后端 | Rust（stable，2024 edition）+ rusqlite（bundled SQLite）+ serde |

## 常用命令

```bash
pnpm install          # 安装前端依赖
pnpm tauri dev        # 开发模式（热更新）
pnpm tauri build      # 打包（Win 下出 .msi/.exe，macOS 出 .dmg/.app）
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
  src/error.rs     # 统一错误类型
docs/           # 技术文档
```

## 领域规则红线（违反即 bug）

1. **状态传播只在 Rust 层实现**。所有节点状态变更必须经 Tauri command → `propagate.rs`，前端**不得**在任何路径自行计算或修改状态。规则定义见 `docs/02-data-model.md` §2（规则表 C1/M1/M2/M3/D1 + 向上传播算法 + Corner Cases CC1–CC8）。
2. **操作与传播必须同一事务**。任何变更类 command 要么完整提交（写入 + 级联 + 向上传播），要么整体回滚。
3. **前端只持有渲染快照**，每次变更后以 Rust 返回的最新数据为准，不维护第二份真相。
4. **新建节点永远是 pending**（不变量 I4），无任何例外。
5. 修改 schema 必须走迁移（`schema_version`），禁止改表不升版本。

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

文档与代码不一致时，以文档描述的领域规则为准，改代码；文档本身错了才改文档（并在 PR 中说明理由）。

## 测试要求

- `propagate.rs`、`db/`：单元测试必须覆盖对应规则表的每一行 + 全部 Corner Cases；新增行为先写测试。
- 前端：状态传播相关交互（完成/取消/级联）须有集成冒烟；布局纯函数（`lib/`）须有单测。
- 提交前：`cargo test` + `cargo clippy` + `pnpm build` 全绿。

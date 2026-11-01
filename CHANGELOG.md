# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 项目初始化：`README.md`、`AGENTS.md`、`CHANGELOG.md`、`.gitignore`。
- 技术方案文档（`docs/`）：
  - `01-overview.md` 技术选型（Tauri 2 + React 19 + TypeScript + SQLite）与总体架构
  - `02-data-model.md` 节点数据模型、状态传播规则（C1/M1/M2/M3/D1）与 Corner Cases
  - `03-feature-design.md` 功能全景与树形 / 平铺双视图设计
  - `04-ui-ux-design.md` 设计原则、布局、视觉与快捷键体系
  - `05-roadmap.md` 里程碑（M1–M4）与 v0.1.0 验收标准
- **M1 实现（v0.1.0 开发中）**：
  - Rust 数据层：SQLite Schema（`nodes` / `schema_version`）、迁移框架、启动备份（`.bak`）
  - 状态传播引擎：创建（C1）、完成级联（M1/M2）、取消级联（M3）、删除（D1）、向上传播（含剪枝与 CC4 叶子化处理）；13 个单元测试覆盖规则表与 CC1–CC8，含 2041 节点级联冒烟
  - IPC 命令（受影响快照返回约定）：`get_tree` / `create_node` / `update_content` / `toggle_status` / `delete_node` / `set_collapsed` / `expand_nodes`
  - 树形（脑图）视图：d3-hierarchy 多根布局 + @xyflow/react 画布、折叠（+N 角标）、done 支线变灰、全键盘心流（N / Tab / Enter / Space / Delete / F2 / 方向键）、非模态删除确认、空态引导、明暗主题跟随系统
  - 平铺视图：叶子节点按「待处理 / 已完成」分组、面包屑路径、点击跳转树形定位
  - 状态栏：叶子统计与完成率、缩放控制
- 应用图标：手绘 SVG 矢量图标（树形分支 + 待办对勾徽章，品牌蓝渐变），`assets/icon.svg` 源文件 + `scripts/gen-icon.mjs` 转换链 + `pnpm tauri icon` 生成全套平台格式
- UI 打磨：品牌图标（顶栏 / 空态）、macOS 分段控件式视图切换、布局变化平滑过渡（220ms）、平铺视图完成时间人性化显示（今天 / 昨天 / M月d日）、状态栏数字排版、节点卡片 hover 阴影层次

## [0.1.0] — 计划中

首个可用版本（M1），详见 [docs/05-roadmap.md](docs/05-roadmap.md)。

### 计划新增

- 树形（脑图）视图：无限层级、缩放平移、折叠展开
- 节点增删改与键盘心流（N / Tab / Enter / Space / Delete）
- 状态自动传播：完成级联、父节点自动完成与回退
- 平铺视图：叶子节点按待处理 / 已完成分组
- 本地 SQLite 持久化与启动备份

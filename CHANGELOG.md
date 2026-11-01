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

## [0.1.0] — 计划中

首个可用版本（M1），详见 [docs/05-roadmap.md](docs/05-roadmap.md)。

### 计划新增

- 树形（脑图）视图：无限层级、缩放平移、折叠展开
- 节点增删改与键盘心流（N / Tab / Enter / Space / Delete）
- 状态自动传播：完成级联、父节点自动完成与回退
- 平铺视图：叶子节点按待处理 / 已完成分组
- 本地 SQLite 持久化与启动备份

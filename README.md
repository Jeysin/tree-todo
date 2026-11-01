# tree-todo

<p align="center">
  <img src="assets/icon-1024.png" width="120" alt="tree-todo 图标" />
</p>

> 树形待办 —— 让待办像脑图一样生长

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)](#)
[![Status](https://img.shields.io/badge/status-%E5%BC%80%E5%8F%91%E4%B8%AD-orange)](#路线图)

**tree-todo** 是一个跨平台（Windows / macOS）桌面待办应用。它把脑图的「无限层级拆解」和待办清单的「状态追踪」合二为一：任何节点可以无限创建子节点，任何节点可以完成 / 取消完成，而状态沿树自动传播。

## 为什么需要它

在 AI Agent 全面爆发的时代，独立开发者、一人公司、超级个体往往同时推进多条任务线：一个目标拆成多个任务，一个任务又拆成多个子任务。传统平铺型待办软件只能线性罗列，既表达不出「总目标 → 子任务」的拆解结构，也看不清「哪条线还堵着、哪条线快完了」。

tree-todo 用一棵可无限生长的树来管理这一切：

- **脑图式无限层级**：任意节点继续拆子节点，任务分解不受限；
- **状态自动传播**：子节点全部完成 → 父节点自动变已完成；在已完成节点下新增子节点 → 父节点自动回退为待处理；
- **双视角**：树形（脑图）视图看结构全貌，平铺视图集中列出所有待处理 / 已完成的叶子事项；
- **本地优先**：数据存于本地 SQLite 单文件，零配置、零联网、复制文件即备份。

## 界面预览

> 📸 开发中，首个可截图版本（v0.1.0）发布后补充。

## 快速开始（开发者）

### 环境要求

- Node.js ≥ 22，pnpm ≥ 9
- Rust ≥ 1.80（stable）
- Windows：WebView2（Win11 自带）；macOS：Xcode Command Line Tools

```bash
pnpm install
pnpm tauri dev     # 开发模式
pnpm tauri build   # 打包安装包
```

> v0.1.0 发布后将提供直接下载的安装包，无需自行构建。

## 文档导航

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | AI 编码代理工作指南（技术栈、规范、领域规则红线） |
| [docs/01-overview.md](docs/01-overview.md) | 技术选型与总体架构 |
| [docs/02-data-model.md](docs/02-data-model.md) | 数据模型与状态传播规则（核心领域逻辑） |
| [docs/03-feature-design.md](docs/03-feature-design.md) | 功能设计（树形 / 平铺视图、节点操作） |
| [docs/04-ui-ux-design.md](docs/04-ui-ux-design.md) | UI / UX 设计 |
| [docs/05-roadmap.md](docs/05-roadmap.md) | 开发路线图与里程碑验收标准 |
| [CHANGELOG.md](CHANGELOG.md) | 更新日志 |

## 路线图

| 版本 | 主题 |
|---|---|
| v0.1.0 | MVP：树形视图、状态自动传播、平铺视图、快捷键体系 |
| v0.2.0 | 拖拽移动、撤销重做、搜索、备注、JSON 导入导出 |
| v0.3.0 | 明暗主题、多文档、回收站、统计面板 |
| v1.0.0 | 正式发布：安装包签名公证、自动更新 |

详见 [docs/05-roadmap.md](docs/05-roadmap.md)。

## License

[MIT](LICENSE)

# 11 · Linux 安装包与发布

> 状态：**已发布**（v2.1.0，2026-11-14）
>
> 关联：`.github/workflows/release.yml`、`scripts/updater-manifest.mjs`、`scripts/gitee-release.mjs`、`docs/08-auto-update.md`、`docs/09-gitee-release.md`
>
> 目标：GitHub Release 在 Windows / macOS 之外，同时提供 Ubuntu / Debian 的 `.deb`、Fedora / RHEL 的 `.rpm` 与通用 `.AppImage`。

---

## 0. 结论先行

| 项 | 结论 |
|---|---|
| 构建机 | GitHub Actions `ubuntu-22.04`（x64），与 macOS / Windows 并列一条矩阵腿 |
| 产物 | `.deb`（apt / dpkg）、`.rpm`（dnf / zypper）、`.AppImage`（免安装） |
| 更新载体 | `.AppImage` + `.AppImage.sig`（Tauri updater 在 Linux 的唯一可安装格式） |
| 应用内更新 | **不做**。Linux 只提示新版本，主按钮「前往下载」打开 GitHub Releases（决策见 `docs/08` D6） |
| 兼容基线 | Ubuntu 22.04+ / Debian 12+（glibc 2.35、WebKitGTK 4.1） |
| 分发 | GitHub Release + Gitee Release（10 类产物；发版后本机执行 `pnpm release:gitee`，理由见 `docs/09` §7） |

**一句话**：Windows / macOS 的发布链路不变，新增一条 `ubuntu-22.04` 腿出三种 Linux 包；Linux 的更新只负责「告诉你」，安装交给包管理器或用户。

---

## 1. 产物与平台范围

| 文件 | 安装方式 | 适用 |
|---|---|---|
| `*.deb` | `sudo apt install ./<file>.deb` | Ubuntu 22.04+、Debian 12+ |
| `*.rpm` | `sudo dnf install ./<file>.rpm` | Fedora、RHEL 系 |
| `*.AppImage` | `chmod +x` 后直接运行 | 任意 x64 桌面发行版 |
| `*.AppImage.sig` | 不直接安装 | `latest.json` 的 Ed25519 签名 |

本期只做 **x86_64**。ARM64 需要新增 `ubuntu-22.04-arm` 矩阵腿与 `linux-aarch64` 清单键，见 §9。

---

## 2. 构建基线：为什么必须是 Ubuntu 22.04

Tauri 的 Linux 产物链接系统 glibc，构建机越新，最低 glibc 越高：

- `ubuntu-22.04` → glibc **2.35**，覆盖 Ubuntu 22.04+ / Debian 12+；
- `ubuntu-latest`（当前 24.04）→ glibc **2.39**，22.04 用户会报 `GLIBC_2.39 not found`。

因此 `release.yml` 固定 `platform: ubuntu-22.04`，**不要**改成 `ubuntu-latest`。

CI 安装的系统依赖：

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf libfuse2 rpm xdg-utils
```

| 依赖 | 用途 |
|---|---|
| `libwebkit2gtk-4.1-dev` | Tauri v2 的 WebView（4.1 是硬要求） |
| `libayatana-appindicator3-dev` / `librsvg2-dev` | GTK / 托盘 / 图标相关链接依赖 |
| `patchelf` | AppImage 重写 RPATH |
| `libfuse2` | `linuxdeploy` 自身是 AppImage，需要 FUSE 挂载 |
| `rpm` | 校验 RPM 产物 / 兼容旧版打包链路 |
| `xdg-utils` | 应用 `open_path` 调 `xdg-open` 打开下载页与目录 |

`APPIMAGE_EXTRACT_AND_RUN=1` 在 Linux 腿生效：GitHub runner 曾移除 `libfuse2`，该变量让 `linuxdeploy` 解包运行，避免 `failed to run linuxdeploy`。

---

## 3. CI 与发布链路

`release.yml` 的 `build` 矩阵：

| 腿 | runner | 产物 |
|---|---|---|
| macOS (universal) | `macos-latest` | `.dmg`、`.app.tar.gz`、`.sig` |
| Windows (x64) | `windows-latest` | `-setup.exe`、`.sig` |
| Linux (x64) | `ubuntu-22.04` | `.deb`、`.rpm`、`.AppImage`、`.AppImage.sig` |

Linux 腿在 `tauri-action` 之后增加产物自检：`deb/*.deb`、`rpm/*.rpm`、`appimage/*.AppImage`、`appimage/*.AppImage.sig` 缺一即失败，防止签名密钥缺失或 AppImage 打包失败时静默发版。

下游：

- `publish-manifest`：`latest.json` 增加 `linux-x86_64`，签名取 `*.AppImage.sig`；
- Gitee 镜像**不在 CI 里**：跨境上传会卡死（v2.1.0 实测 4.58MB 传 39 分钟未完成），改由发版后本机执行 `pnpm release:gitee --tag vX.Y.Z`，见 `docs/09` §7；
- 手动 `workflow_dispatch` 的 artifact 上传路径同步加入 Linux 产物。

---

## 4. Tauri 配置

```jsonc
{
  "bundle": {
    "targets": ["app", "dmg", "nsis", "deb", "rpm", "appimage"],
    "linux": {
      "deb": {
        // depends 会覆盖默认列表，必须把 webkit / gtk 一并写全
        "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0", "xdg-utils"]
      },
      "rpm": {
        "depends": ["webkit2gtk4.1", "gtk3", "xdg-utils"]
      }
    }
  }
}
```

`createUpdaterArtifacts: true` 在 Linux 上会额外产出 `*.AppImage.sig`；`.deb` / `.rpm` 不带更新签名，也不参与应用内安装。

---

## 5. 自动更新：只提示，不安装

`latest.json` 的平台键：

```json
"linux-x86_64": { "signature": "…", "url": "https://github.com/…/Tree.Todo_x.y.z_amd64.AppImage" }
```

Tauri 2.14 的匹配顺序是 `linux-x86_64-{appimage,deb,rpm}` → `linux-x86_64`，所以只写一个键，三种安装形态都能发现新版本。

前端（`src/stores/updateStore.ts`）在 Linux 上：

- `check()` 正常执行，有更新就弹窗；
- 主按钮固定「前往下载」，`install()` 直接 `openDownloadPage()`，不调用 `downloadAndInstall()`；
- 不展示「更新会重启应用」提示（不执行应用内安装）。

原因：`.deb` 安装到 root 拥有的 `/usr/bin`，`.rpm` 由包管理器维护，原地替换会破坏 dpkg / rpm 数据库；AppImage 虽可自更新，但本期统一为一条路径，避免同平台两套行为。

---

## 6. 安装说明（README 摘要）

```bash
# Ubuntu / Debian
sudo apt install ./<file>.deb

# Fedora / RHEL
sudo dnf install ./<file>.rpm

# 通用
chmod +x <file>.AppImage
./<file>.AppImage
```

Ubuntu 24.04 默认不带 FUSE2，AppImage 需先装 `libfuse2t64`，或加 `--appimage-extract-and-run` 运行；日常使用推荐 `.deb`。

---

## 7. 验收清单

1. `workflow_dispatch` 跑通三腿（不建 Release），确认 Linux 四种文件齐全；本地 `cargo test` / `cargo clippy --all-targets -- -D warnings` / `pnpm build` 全绿。
2. Ubuntu 22.04 与 24.04 各装一次 `.deb`；Fedora（或容器）装一次 `.rpm`；AppImage 直接运行一次。
3. 启动后检查：树视图渲染、数据目录 `~/.local/share/com.jeysin.treetodo/`、复制 Prompt（原生剪贴板）、`xdg-open` 打开下载页 / 目录、Help 菜单「检查更新…」、MCP 服务端口与 token。
4. 更新检查：有更新时弹窗主按钮为「前往下载」；无更新手动检查提示「已是最新版本」；有任务执行中不出现重启提示。
5. `latest.json` 同时含 `darwin-aarch64` / `darwin-x86_64` / `windows-x86_64` / `linux-x86_64` 四个键，Linux 签名与 `.AppImage.sig` 一致。
6. 本机执行 `pnpm release:gitee --tag vX.Y.Z --require-complete` 后，Gitee Release 附件数为 10（源码包另计）；日志里每个附件的速率应在 MB/s 量级（若是 KB/s 量级，说明出口线路有问题，换网络重跑）。

---

## 8. 风险与边界

| 风险 | 应对 |
|---|---|
| 22.04 基线不覆盖 Ubuntu 20.04 | README 明确最低 22.04 / Debian 12；20.04 无 WebKitGTK 4.1 |
| Ubuntu 24.04 默认无 FUSE2 | 文档给 `libfuse2t64` / `--appimage-extract-and-run`，推荐 `.deb` |
| Wayland + NVIDIA 下 AppImage 偶发 WebKit EGL 白屏 | 可临时 `WEBKIT_DISABLE_DMABUF_RENDERER=1`；建议改用 `.deb` |
| `.deb` / `.rpm` 不能应用内更新 | 统一「前往下载」，不做半套自动安装 |
| Gitee 单附件 100MB | AppImage 约 70MB；`--require-complete` 下必需产物超限直接失败 |
| RPM 依赖名随发行版不同 | 当前按 Fedora 系命名；openSUSE 等需要单独 config 覆盖 |

---

## 9. 后续扩展

- **ARM64**：新增 `ubuntu-22.04-arm` 腿，产出 `arm64` deb / `aarch64` rpm / `aarch64` AppImage，清单加 `linux-aarch64`；
- **AppImage 应用内更新**：新增 Rust command 读 `APPIMAGE` 环境变量，AppImage 走 `downloadAndInstall()`，deb/rpm 继续下载页；
- **RPM 签名**：CI 注入 `TAURI_SIGNING_RPM_KEY`（GPG），与 Ed25519 更新签名是两套体系；
- **Snap / Flatpak**：不改变现有 deb/rpm/AppImage 链路，单独加发布 job。

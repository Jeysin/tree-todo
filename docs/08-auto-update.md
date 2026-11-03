# 08 · 自动更新（技术方案）

> 状态：**已确认，随 v2.0.0 实施**（代码完成，待双平台实测）
>
> 目标版本：v2.0.0（2.0.0 是首个带更新能力的版本；1.0.0 已发布但不含更新能力）
>
> 关联：`docs/05-roadmap.md` M4「自动更新」、`docs/04-ui-ux-design.md` §2 侧边栏
>
> 需求来源：2026-11-03 口头需求（自动检查 + 双手动入口 + 更新弹窗）

---

## 0. 结论先行

| 项 | 结论 |
|---|---|
| 更新机制 | Tauri 官方 `tauri-plugin-updater` + GitHub Releases 上的静态清单 `latest.json` |
| 更新源 | `https://github.com/Jeysin/tree-todo/releases/latest/download/latest.json`（仓库已确认 public） |
| 完整性 | Ed25519 签名，**强制校验**，签名不通过一律不安装 |
| 三条入口 | 启动自动检查 / 侧边栏版本号 / 系统菜单「检查更新…」，共用同一个 store 与弹窗 |
| 安装体验 | 弹窗内展示版本号 + 版本介绍，点「立即更新」→ 下载（带进度）→ 安装 → 自动重启 |
| 主要前置条件 | ① 生成并保管签名密钥；② CI 注入密钥并产出 `latest.json`；③ macOS 本期不签名，安装降级为打开下载页（见 §12 D1） |
| 预估工作量 | 3–3.5 人日（不含 Apple 开发者账号申请与公证等待） |

**一句话架构**：GitHub Release 里放一份带签名的 `latest.json` → 应用启动/手动触发时拉取并比对版本 → 有新版弹窗 → 用户确认后插件下载安装包、验签、调用系统安装器 → 重启。

> 说明：需求里说「检查 GitHub 仓库是否有新版本」，实现上**不轮询 GitHub API**，而是读取随每个 Release 发布的静态清单 `latest.json`。这是 Tauri 官方机制：无 API 限流、无需解析 Release、自带平台匹配与签名校验，效果与「检查仓库有没有新版本」一致。

---

## 1. 需求拆解与验收口径

| ID | 需求 | 验收口径 |
|---|---|---|
| R1 | 自动检查新版本 | 正式包每次启动后自动检查一次；有新版本弹窗；无新版本**不打扰**；检查失败静默 |
| R2 | 更新弹窗内容 | 必须展示「当前版本 → 最新版本」与版本介绍（release notes），介绍可滚动 |
| R3 | 一键下载安装 | 弹窗主按钮触发下载（有百分比进度）→ 安装 → 自动重启；失败可重试且不破坏现有安装 |
| R4 | 版本号入口 | 左上角版本号可点击、带**蓝色下划线**；有更新弹窗，无更新 toast「已是最新版本」 |
| R5 | 系统菜单入口 | 菜单中「检查更新…」行为与 R4 完全一致（同一条代码路径） |
| R6 | 无更新提示 | 两个手动入口均给出「已是最新版本」的明确反馈；自动检查保持静默 |

---

## 2. 技术选型

### 2.1 为什么用 `tauri-plugin-updater`

| 方案 | 结论 |
|---|---|
| 官方 updater 插件 | ✅ 采用。跨平台安装器调用、Ed25519 验签、进度事件、版本比较全部现成 |
| 自己调 GitHub API + 下载 + 安装 | ❌ 需要处理 API 限流、资产匹配、平台差异（NSIS / .app 替换）、签名校验，全是坑 |
| 第三方更新服务（CrabNebula 等） | ❌ 引入外部依赖与费用，当前分发量用不上 |

### 2.2 更新源与清单

- 每个 Release 附带一个 `latest.json`（Tauri 静态清单格式），地址固定为 `releases/latest/download/latest.json`。
- GitHub 的 `releases/latest` 只指向**最新正式版**（draft / prerelease 不计入），正好符合「有新版本才提示」。
- 清单里同时列出 macOS 两个架构键与 Windows 键：

```json
{
  "version": "2.1.0",
  "notes": "本次更新：\n- 支持自动更新\n- 修复……",
  "pub_date": "2026-11-10T12:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "…", "url": "https://github.com/…/Tree.Todo.app.tar.gz" },
    "darwin-x86_64":  { "signature": "…", "url": "https://github.com/…/Tree.Todo.app.tar.gz" },
    "windows-x86_64": { "signature": "…", "url": "https://github.com/…/Tree.Todo_2.1.0_x64-setup.exe" }
  }
}
```

> ⚠️ 三个已确认的坑：
> 1. **没有 `darwin-universal` 这个键**。Tauri 只认 `OS-ARCH`（`darwin-aarch64` / `darwin-x86_64` / `windows-x86_64` …）。本项目 macOS 出的是 universal 包，必须让两个 darwin 键指向**同一个** `.app.tar.gz`，否则 Intel 机器会静默判定「无更新」。
> 2. macOS 的更新资产是 `.app.tar.gz`，不是 `.dmg`；Windows 用 NSIS 的 `-setup.exe`。
> 3. Tauri 会**先校验整份清单**再比对版本，任一平台条目签名/URL 缺失都会导致所有人检查失败。清单必须由脚本生成，不能手写。

### 2.3 签名（不可关闭）

- 本地生成一次密钥对，公钥写进 `tauri.conf.json`，私钥只存在于 GitHub Secrets 与离线备份。
- **私钥丢失 = 已安装用户永远无法再收到更新**（只能让用户手动重装）。必须离线备份。
- 签名校验失败时插件直接报错，我们的 UI 提示「安装包校验失败，已取消更新」。

---

## 3. 总体架构与数据流

```
                 ┌──────────────────────── GitHub Release ────────────────────────┐
                 │  latest.json（版本 / notes / 各平台 url + signature）           │
                 │  Tree.Todo.app.tar.gz(.sig)   Tree.Todo_x.y.z_x64-setup.exe(.sig)│
                 └───────────────────────────────┬────────────────────────────────┘
                                                 │ HTTPS
┌──────────────────────── 应用进程 ────────────────┼────────────────────────────────┐
│                                                 ▼                                │
│  入口 A 启动后 3s ─┐                    tauri-plugin-updater                      │
│  入口 B 版本号点击 ─┼──► updateStore ──► check() ──► 有更新 ──► UpdateDialog       │
│  入口 C 菜单项 ────┘        │                              │                    │
│                             │                              ▼                    │
│                             │                    downloadAndInstall()           │
│                             │                     ├─ Started / Progress 事件    │
│                             │                     ├─ 验签 + 调用系统安装器       │
│                             │                     └─ Windows 安装时自动退出      │
│                             └── 无更新 → toast「已是最新版本」（仅手动态）        │
│                                                                                 │
│  安装完成后：macOS 调 relaunch() 重启；Windows 由安装器接管，重启即新版本          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

关键点：**检查与安装逻辑放前端插件层**（`src/ipc/update.ts` 封装），Rust 侧只做插件注册与菜单事件。理由：整个流程由 UI 驱动，插件 JS API 已完整覆盖；Rust 再包一层只会多一套事件与状态同步。数据层（SQLite / 文档 / 回收站）完全不参与更新。

---

## 4. 配置与依赖改动

### 4.1 `src-tauri/tauri.conf.json`

```jsonc
{
  "bundle": {
    "createUpdaterArtifacts": true          // 新增：产出 .app.tar.gz/.exe 与 .sig
  },
  "plugins": {
    "updater": {
      "pubkey": "<tauri signer generate 输出的公钥>",
      "endpoints": [
        "https://github.com/Jeysin/tree-todo/releases/latest/download/latest.json"
      ],
      "windows": { "installMode": "passive" }   // 默认值，显式写出便于 review
    }
  }
}
```

- `installMode: "passive"`：Windows 更新时显示系统进度条、无需用户点击，符合「点一下自动装完」。
- 本地影响：`createUpdaterArtifacts: true` 后，`pnpm tauri build` 需要 `TAURI_SIGNING_PRIVATE_KEY`；只写前端用 `pnpm build`，本地调试用 `pnpm tauri dev`，均不受影响。无密钥时可用 `pnpm tauri build --no-bundle`。

### 4.2 依赖

```toml
# src-tauri/Cargo.toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"      # relaunch()
```

```bash
pnpm add @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

### 4.3 权限 `src-tauri/capabilities/default.json`

```json
{
  "permissions": ["core:default", "dialog:default", "updater:default", "process:allow-restart"]
}
```

> 同时把该文件的 `description` 从「无任何插件权限」改为实际描述，避免误导。

### 4.4 签名密钥（一次性，人工执行）

```bash
pnpm tauri signer generate -w ~/.tauri/tree-todo.key
# 公钥 → 粘贴进 tauri.conf.json 的 plugins.updater.pubkey（已写入）
# 私钥 → GitHub Secrets：
#   TAURI_SIGNING_PRIVATE_KEY = 私钥文件内容（整个 ~/.tauri/tree-todo.key）
# 本项目密钥未设口令，TAURI_SIGNING_PRIVATE_KEY_PASSWORD 留空即可；
# 若后续更换为带口令的密钥，再补这个 secret。
```

当前密钥已于 2026-11-03 生成在本机 `~/.tauri/tree-todo.key`（权限 600，不在仓库内）。
**必须离线备份**：私钥丢失后，已安装用户将无法再收到任何更新。

---

## 5. Rust 侧改动（`src-tauri/src/lib.rs`）

1. 注册插件：

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
```

2. 新增菜单常量与菜单项：

```rust
const MENU_CHECK_UPDATE: &str = "check_update";
```

在 `install_menu` 里（现有 `File` 菜单逻辑之后）：

- **macOS**：取 `menu.items()?` 的第一个 `Submenu`（系统应用菜单，标题即产品名），把「检查更新…」插到索引 1（「关于 Tree Todo」之后、第一条分隔线之前）。
- **Windows**：原生菜单栏没有「应用名」菜单，改为插入 **Help 菜单首项**；若无 Help 子菜单则创建一个。
  - 备选：在 Windows 也建一个名为 `Tree Todo` 的顶级菜单（更贴字面需求，但不符合 Windows 习惯）。见 §12 D2。

```rust
let check = MenuItem::with_id(app, MENU_CHECK_UPDATE, "检查更新…", true, None::<&str>)?;
// macOS: app_menu.insert(&check, 1)?;
// Windows: help_menu.insert(&check, 0)?;
```

3. 事件分发（现有 `on_menu_event` 加一个分支）：

```rust
MENU_CHECK_UPDATE => { let _ = app.emit("menu:check-update", ()); }
```

4. 不新增任何 Tauri command，不动 `commands/`、`propagate.rs`、`db/`。

---

## 6. 前端改动

### 6.1 `src/ipc/update.ts`（新增，唯一插件出口）

按项目约定（组件禁止裸调插件/`invoke`），把插件 API 包成带类型的函数，并持有 `Update` 句柄：

```ts
export interface UpdateInfo {
  version: string;          // 最新版本
  currentVersion: string;   // 当前版本
  notes: string;            // 版本介绍
  date?: string;            // pub_date
}

export const updaterIpc = {
  /** 检查更新；无更新返回 null。timeout 15s。 */
  check: (): Promise<UpdateInfo | null>;
  /** 下载并安装已检查到的版本；cb 汇报进度。 */
  install: (cb: (p: { downloaded: number; total: number | null }) => void): Promise<void>;
  /** 重启应用（Windows 安装时会先被系统退出，不会走到这里）。 */
  relaunch: (): Promise<void>;
};
```

实现要点：

- 模块级变量 `pendingUpdate` 保存 `check()` 返回的 `Update`，`install()` 复用；`install` 前若为空则抛错（防止状态错位）。
- `check()` 捕获 `{ timeout: 15000 }`；`install()` 不设超时。
- 只在 `import.meta.env.PROD` 下允许调用；dev 直接返回 `null`（避免 `tauri dev` 里出现无法安装的假更新）。

### 6.2 `src/stores/updateStore.ts`（新增，Zustand）

```ts
type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'error';

interface UpdateState {
  phase: Phase;
  info: UpdateInfo | null;
  progress: { downloaded: number; total: number | null };
  error: string | null;
  dialogOpen: boolean;
  dismissed: boolean;            // 本次会话已忽略，自动检查不再弹
  appVersion: string;            // 打开弹窗时展示「当前版本」

  check(opts: { manual: boolean }): Promise<void>;
  install(): Promise<void>;
  openDialog(): void;
  closeDialog(): void;
}
```

状态机：

```
idle ──check()──► checking ──null──► idle            （manual 时 toast「已是最新版本」）
                     │
                     └──有更新──► available ──install()──► downloading ──完成──► installing ──► 重启
                                      │                        │
                                      └── closeDialog ──► available（dismissed=true）       └── 失败 ──► error ──重试──┘
```

行为约定：

| 场景 | 行为 |
|---|---|
| 重复触发检查（自动 + 手动撞车） | store 内 `checking` 复用同一个 Promise，不重复请求 |
| 已发现更新后再次点版本号 / 菜单 | 不重新联网，直接重开弹窗 |
| 下载中关闭弹窗 | 下载继续；再次点入口重开弹窗并显示实时进度（插件不支持取消下载，按钮置灰说明） |
| 手动检查失败 | `phase='idle'` + toast「检查更新失败，请检查网络后重试」（不弹窗） |
| 自动检查失败 | 完全静默（仅 console），不写 toast、不弹窗 |
| 当前版本 ≥ 清单版本 | 视为无更新（插件默认不降级） |

无更新提示复用现有 `useTodoStore.getState().showToast('已是最新版本')`，不新造 toast。

### 6.3 `src/components/UpdateDialog.tsx`（新增）

结构：

```
┌─────────────────────────────────────────┐
│ 发现新版本                          ✕  │  ← 头部 44px
├─────────────────────────────────────────┤
│ v2.0.0  →  v2.1.0                       │  ← 当前 muted / 新版 accent 加粗
│ ┌─────────────────────────────────────┐ │
│ │ 版本介绍（release notes）            │ │  ← max-h 220px，可滚动
│ │ - 支持自动更新                       │ │     bg-base + border
│ │ - 修复……                             │ │     whitespace-pre-wrap
│ └─────────────────────────────────────┘ │
│ ▓▓▓▓▓▓░░░░░░░░  正在下载 42% · 3.2/7.6MB │  ← 仅 downloading 显示
├─────────────────────────────────────────┤
│                        稍后   立即更新  │
└─────────────────────────────────────────┘
```

- 遮罩：`fixed inset-0 z-[60] bg-black/45 flex items-center justify-center`；面板 `w-[460px] rounded-xl border border-border bg-elevated shadow-2xl`。
- 颜色全部走 token（`bg-elevated` / `border-border` / `text-muted` / `text-accent`），不硬编码。
- 版本介绍按纯文本渲染（`whitespace-pre-wrap`），`- ` 开头的行前面加圆点；**不引入 markdown 依赖**。
- 按钮态：
  - `available`：`稍后` + `立即更新`（主按钮 accent）
  - macOS：主按钮改为「前往下载」，点击打开 GitHub Releases 下载页，不做应用内安装
  - `downloading`：主按钮变「下载中…」禁用，显示进度条与百分比
  - `installing`：显示「正在安装，应用即将重启…」，禁用关闭
  - `error`：显示「更新失败：{原因}」+ `重试` + `打开下载页`
- 若当前有 `running` 的执行任务，正文顶部加一行 warning：「有 N 个任务正在执行，更新会重启应用；执行记录会保留」。
- 可访问性：`role="dialog" aria-modal="true"`，`Esc` 关闭（installing 除外），打开时焦点落在主按钮。

### 6.4 侧边栏版本号（`src/components/Sidebar.tsx`）

现在是一个 `<span>`（约 745–757 行），改为按钮：

```tsx
<button
  type="button"
  onClick={() => void useUpdateStore.getState().check({ manual: true })}
  disabled={phase === 'checking' || phase === 'downloading' || phase === 'installing'}
  title="检查更新"
  className="text-[11px] tabular-nums text-accent underline decoration-accent/40
             underline-offset-2 hover:decoration-accent disabled:opacity-50 transition-colors"
>
  v{version}
</button>
```

- 蓝色下划线 = `text-accent` + `underline`，accent 在两套主题下都是蓝色（`#2f6fed` / `#4f8cff`），符合「蓝色下划线」且不违反「禁止硬编码色值」。
- 检查中：版本号右侧加 10px `Loader2` 旋转图标，不改变布局宽度。
- 点击后无更新 → toast；有更新 → 弹窗。

### 6.5 `src/App.tsx`

1. 启动自动检查（等首屏 `loaded` 后再触发，避免和首屏加载抢带宽）：

```tsx
useEffect(() => {
  if (!loaded || !import.meta.env.PROD) return;
  const t = setTimeout(() => void useUpdateStore.getState().check({ manual: false }), 3000);
  return () => clearTimeout(t);
}, [loaded]);
```

2. 监听系统菜单事件（与现有 `menu:export-all` 放在一起）：

```tsx
listen('menu:check-update', () => void useUpdateStore.getState().check({ manual: true }))
```

3. 挂载 `<UpdateDialog />`（放在 `<ToastContainer />` 同级）。

**自动弹窗不打断输入**：若 3s 到点时焦点在 `input/textarea/contenteditable`（用户正在改节点），每 15s 重试、最多 6 次（约 1.5 分钟）再弹；期间若用户主动点版本号，立即走手动流程。

### 6.6 版本号展示来源

- 当前版本继续用 `getVersion()`（读 `tauri.conf.json` 的 `version`），不新增 IPC。
- `updateStore.appVersion` 在首次挂载时取一次，弹窗里的「当前版本」用它。

---

## 7. 发布流水线改造（`.github/workflows/release.yml`）

### 7.1 现状

- 已有 tag 触发、macOS universal + Windows x64 双 job、`tauri-action@v1`。
- 当前显式 `uploadUpdaterJson: false`，且注释写明「未接入自动更新」→ 本次要改。

### 7.2 改动点

1. 两个 build job 增加环境变量：

```yaml
env:
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

2. `tauri-action` 保持 `uploadUpdaterJson: false`（清单由独立 job 生成，见下），`releaseBody` 暂用现有模板；正文与 `notes` 由 `publish-manifest` job 统一改写，避免两个矩阵 job 跨平台处理多行文本。

3. 新增 `publish-manifest` job（在 build 之后，仅 tag 触发）：

```yaml
publish-manifest:
  needs: build
  if: startsWith(github.ref, 'refs/tags/')
  runs-on: ubuntu-latest
  permissions: { contents: write }
  steps:
    - uses: actions/checkout@v5
    - name: Sync release notes
      run: gh release edit "$TAG" --notes-file "release-notes/$TAG.md"
      env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}, TAG: ${{ github.ref_name }} }
    - run: node scripts/updater-manifest.mjs
      env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}, TAG: ${{ github.ref_name }} }
    - run: gh release upload "$TAG" latest.json --clobber
      env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}, TAG: ${{ github.ref_name }} }
```

### 7.3 `scripts/updater-manifest.mjs`（新增）

不做「猜文件名」，一切以 GitHub API 返回的真实资产为准：

1. 校验 `TAG` 去掉 `v` 后 === `tauri.conf.json.version`，不一致直接失败（防止发错版本）。
2. `gh release view $TAG --json assets,body,publishedAt`。
3. 在资产中定位：
   - macOS：`*.app.tar.gz` 与其 `.sig`
   - Windows：`*-setup.exe` 与其 `.sig`
   - 缺任一 → 报错退出（宁可不发，也不发一份坏清单）
4. 读取 `.sig` 文件内容作为 `signature`。
5. 生成 `latest.json`：`darwin-aarch64` 与 `darwin-x86_64` **都指向同一个** `*.app.tar.gz`；`windows-x86_64` 指向 `-setup.exe`；`notes` 取 `release-notes/vX.Y.Z.md` 正文，`pub_date` 取 `publishedAt`。
6. 只写出 `latest.json`；上传由 workflow 的下一个 step 完成（脚本保持纯函数、可本地重跑）。

### 7.4 版本介绍（release notes）来源

新增 `release-notes/vX.Y.Z.md`（面向用户、10 行以内、纯文本 + `-` 列表），作为：

- GitHub Release 正文（`publish-manifest` job 用 `gh release edit --notes-file` 覆盖掉构建时的占位正文）
- `latest.json` 的 `notes`（弹窗展示）

完整的开发明细仍写 `CHANGELOG.md`。CI 在文件缺失时失败，避免弹窗里出现空介绍。

> 示例 `release-notes/v2.0.0.md`（已入库）：
> ```
> Tree Todo 2.0.0 · 首个正式版
> - 树形（脑图）待办：任务无限分层，完成状态沿树自动传播
> - 新增自动更新：启动时自动检查，也可点击左上角版本号或菜单「检查更新…」
> - Windows 可一键下载安装并重启；macOS 版会打开下载页，需手动安装
> ```

### 7.5 发布 SOP

1. 改 `tauri.conf.json` / `package.json` / `Cargo.toml` 版本号（三处一致）。
2. 写 `CHANGELOG.md` 与 `release-notes/vX.Y.Z.md`。
3. `git tag vX.Y.Z && git push origin vX.Y.Z`。
4. CI 出包 → 生成 `latest.json` → 挂到 Release。
5. 用旧版本安装包实测一次升级（§10.2 U-08）。

> **迁移注意**：v1.0.0 已发布但不含 updater，收不到任何推送。2.0.0 发布后，1.0.0 用户需**手动安装一次**；从 2.0.0 起才进入「自动检查 + 一键升级」的链路。README 与 Release 正文要写清这一点。

---

## 8. 异常与边界

| # | 场景 | 期望行为 |
|---|---|---|
| E1 | 无网络 / GitHub 5xx / 超时 | 自动：静默；手动：toast「检查更新失败，请检查网络后重试」 |
| E2 | `latest.json` 404（首个带更新能力的版本尚未发布） | 视为检查失败，不误报「已是最新」 |
| E3 | 清单中缺当前平台键 | 插件判定无更新；由 §7.3 的生成校验兜底，避免发出去 |
| E4 | 签名校验失败 / 安装包损坏 | 不安装，弹窗提示「安装包校验失败，已取消更新」，保留旧版本 |
| E5 | 下载中用户关弹窗 | 后台继续下载；入口可重新打开并看到进度 |
| E6 | 安装中用户强制退出 | 旧版本仍在（macOS 替换前退出）；Windows 由安装器保证原子性 |
| E7 | Windows 安装时应用自动退出 | 正常现象，重启后为新版本；不做「更新完成」二次提示 |
| E8 | 用户当前正在编辑节点 | 自动弹窗延后，最多 1.5 分钟；手动入口立即响应 |
| E9 | 本地开发版版本号高于线上 | 插件默认不降级，视为无更新 |
| E10 | 数据安全 | 更新只替换程序，`app_data_dir`（文档 / 目录 / 回收站 / runs）完全不动；更新前若有 running 任务，弹窗内提示 |
| E11 | 用户忽略更新 | 本次会话不再自动弹；下次启动再检查（不做「跳过此版本」，见 §12 D4） |
| E12 | macOS 打开浏览器失败 | 弹窗提示「无法打开浏览器，请手动访问 GitHub Releases」 |

---

## 9. 安全

- **强制验签**：公钥内嵌在安装包里，私钥只存 CI Secrets + 离线备份；`latest.json` 被篡改也无法通过校验。
- **仅 HTTPS**：不使用 `dangerousInsecureTransportProtocol`（本地测试配置单独放在测试用 config 里，不进正式包）。
- **不降级**：默认只接受更高 semver，避免被诱导回滚到有漏洞的版本。
- **最小权限**：capabilities 只加 `updater:default` 与 `process:allow-restart`。
- **清单唯一出口**：只有 CI 的 `publish-manifest` job 能写 `latest.json`，人工不改 Release 资产。

---

## 10. 测试方案

### 10.1 本地端到端（不污染线上 Release）

1. 生成测试密钥对，公钥写进一份测试配置 `src-tauri/tauri.updater-test.conf.json`：
   ```json
   {
     "plugins": { "updater": {
       "endpoints": ["http://127.0.0.1:8787/latest.json"],
       "dangerousInsecureTransportProtocol": true
     }}
   }
   ```
   构建时用 `--config` 合并（仅本机测试，绝不用于发版）：
   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/tree-todo.key)"
   pnpm tauri build --config src-tauri/tauri.updater-test.conf.json
   ```
2. 构建「旧版」2.0.0（带 updater + 测试配置）并安装。
3. 临时把版本号改成 2.0.1，构建「新版」并签名；把 `Tree Todo.app.tar.gz` / `-setup.exe` 与 `latest.json` 放进本地目录，`python3 -m http.server 8787` 起服务（测完改回 2.0.0）。
4. 启动旧版 → 验证自动弹窗 → 更新 → 重启后 `v2.0.1`。
5. Windows 与 macOS 各跑一遍（Windows 用虚拟机 / 实体机）。

### 10.2 验收用例

| # | 用例 | 平台 | 预期 |
|---|---|---|---|
| U-01 | 启动 3s 后出现更新弹窗 | Win/mac | 弹窗展示版本号与介绍 |
| U-02 | 无更新时启动 | Win/mac | 无任何弹窗 / toast |
| U-03 | 点版本号，有更新 | Win/mac | 弹窗；版本号有蓝色下划线且 hover 加深 |
| U-04 | 点版本号，无更新 | Win/mac | toast「已是最新版本」，5s 自动消失 |
| U-05 | 菜单「检查更新…」有/无更新 | Win/mac | 与 U-03/U-04 一致 |
| U-06 | 点「立即更新」 | Win/mac | 进度从 0 到 100%，安装后自动重启为新版本 |
| U-07 | 断网后手动检查 | Win/mac | toast 网络错误；应用可用 |
| U-08 | 从线上真实旧版升级到新版 | Win/mac | 升级成功，文档 / 目录 / 回收站数据完整 |
| U-09 | 下载中关闭弹窗再打开 | Win/mac | 进度继续，重开可见 |
| U-10 | 篡改 `latest.json` 的 signature | Win/mac | 拒绝安装，旧版本正常 |
| U-11 | 编辑节点时触发自动检查 | Win/mac | 不打断输入，编辑结束后再弹 |
| U-12 | 正在执行任务时更新 | Win/mac | 弹窗出现「N 个任务正在执行」提示；更新后 run 记录仍在 |
| U-13 | macOS 检查到更新 | mac | 弹窗展示版本与介绍，主按钮为「前往下载」，打开 Releases 页面 |
| U-14 | CI 发布 tag 与版本号不一致 | CI | workflow 失败并提示 |

---

## 11. 实施顺序与改动清单

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0-1 | 密钥 + 配置 + CI 清单脚本 | 能发一个带 `latest.json` 的 Release |
| P0-2 | 插件接入 + `ipc/update.ts` + store + 弹窗 + 版本号入口 | 手动检查 → 下载 → 安装闭环 |
| P0-3 | 启动自动检查 + 菜单入口 | 三条入口齐全 |
| P0-4 | 双平台实测 + 文档同步 | 验收通过 |

> P0-1～P0-3 已随 v2.0.0 落地；P0-4 的双平台实测需要真实安装包（Windows 安装一次、macOS 验证「前往下载」），发版前完成。

| 文件 | 改动 |
|---|---|
| `src-tauri/Cargo.toml` | + 两个插件依赖 |
| `src-tauri/src/lib.rs` | 插件注册、菜单项、`menu:check-update` 事件 |
| `src-tauri/tauri.conf.json` | `createUpdaterArtifacts` + `plugins.updater` |
| `src-tauri/capabilities/default.json` | + 两条权限，更新描述 |
| `src/ipc/update.ts` | 新增 |
| `src/stores/updateStore.ts` | 新增 |
| `src/components/UpdateDialog.tsx` | 新增 |
| `src/components/Sidebar.tsx` | 版本号 span → 按钮（蓝色下划线） |
| `src/App.tsx` | 自动检查 + 菜单事件 + 挂载弹窗 |
| `src-tauri/tauri.updater-test.conf.json` | 新增（仅本地测试） |
| `scripts/updater-manifest.mjs` | 新增 |
| `release-notes/v2.1.0.md` | 新增（模板） |
| `.github/workflows/release.yml` | 签名 env + `publish-manifest` job |
| `package.json` | 两个前端插件依赖 |

---

## 12. 决策记录（2026-11-03 已确认）

### D1 已选 B：macOS 本期不做签名公证，安装降级为打开下载页

- macOS 上仍执行 `check()` 并弹出更新弹窗，展示版本号与介绍；
- 主按钮改为「前往下载」，调用系统默认浏览器打开 GitHub Releases；
- 不在 macOS 调用 `downloadAndInstall`，避免未签名包替换后被 Gatekeeper 拦截；
- 后续完成签名 + 公证后，只需删掉 `updateStore.install()` 里的 macOS 分支即可恢复应用内安装。

### D2 已选 A：Windows 菜单入口放 Help 首项

macOS 放应用名菜单「关于」之后；Windows 放 `Help` 菜单首项「检查更新…」。Windows 原生菜单栏没有应用名菜单，这是最符合平台习惯的位置。

### D3 已选 A：每次启动检查一次，失败完全静默

- 启动后 3s 检查一次，不做 24h 节流；
- 用户所在地区访问 GitHub 失败属于常态：自动检查只写 `console.warn`，**不弹窗、不 toast**；
- 只有用户主动点版本号 / 菜单时才提示失败原因。

### D4 本期不做「跳过此版本」

只保留「稍后」（本次会话不再自动弹）。以后要加，在 store 里记 `skippedVersion` 即可。

### D5 已选 A：`release-notes/vX.Y.Z.md` 单一来源

同一份纯文本同时用于 GitHub Release 正文与 `latest.json` 的 `notes`（即弹窗内容）；完整开发明细仍写 `CHANGELOG.md`。CI 在文件缺失时直接失败。

---

## 13. 文档同步（合入时必须）

| 文档 | 更新内容 |
|---|---|
| `docs/01-overview.md` | 依赖与架构补「自动更新」一节（updater 插件、GitHub Releases 清单） |
| `docs/03-feature-design.md` | 功能表加「自动更新」条目 + 三条入口行为 |
| `docs/04-ui-ux-design.md` | 弹窗规格、版本号蓝色下划线、检查中状态 |
| `docs/05-roadmap.md` | 把 M4 的「自动更新」标记为已提前落地 |
| `CHANGELOG.md` | v2.0.0 条目补充「自动更新」（AGENTS.md 要求） |
| `README.md` | 功能列表补充「自动更新」，安装说明写明 macOS 更新会跳下载页 |

---

## 14. 非目标（本期不做）

- **增量 / 差分更新**：每次下载完整安装包（当前包体 < 20MB，成本可接受）。
- **Beta / 灰度通道**：只跟 GitHub 最新正式版，pre-release 不推送。
- **静默强制更新**：必须用户点「立即更新」，不后台偷偷装。
- **跳过指定版本**：只保留「稍后」（见 D4）。
- **Linux 自动更新**：项目只发 Windows / macOS。
- **降级 / 回滚**：默认拒绝低版本；坏版本靠发布更高版本修复。

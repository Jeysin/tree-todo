# 09 · Gitee 发布与安装包分发

> 状态：**已实施**（2026-11-04）
>
> 关联：`docs/08-auto-update.md`（更新源仍是 GitHub Releases）、`.github/workflows/release.yml`、`scripts/gitee-release.mjs`
>
> 目标：代码托管在 Gitee（`git@gitee.com:Jeysin/tree-todo.git`），安装包在 Gitee Release 上可直接下载。

---

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| 用 Gitee 的 CI 构建安装包？ | **不行**，见 §1 |
| 安装包谁构建？ | GitHub Actions（`release.yml`），双平台原生 runner |
| Gitee 侧做什么？ | 代码镜像 + **Release 产物镜像**（`scripts/gitee-release.mjs`） |
| 什么时候镜像？ | 打 tag 后自动（`publish-gitee` job）；也可手动跑 `Mirror release to Gitee` |
| 下载页 | `https://gitee.com/Jeysin/tree-todo/releases` |
| 应用内自动更新从哪拉？ | 仍是 GitHub 的 `latest.json`；Gitee 只做分发（§6） |

**一句话**：GitHub 负责「构建」，Gitee 负责「在国内能下载到」。

---

## 1. 为什么不在 Gitee 上构建

Gitee 的 CI 是 **Gitee Go**（`.workflow/*.yml` 的流水线式 YAML，插件体系与 GitHub Actions 不同）。对本项目有三条硬约束：

| 约束 | 事实 | 影响 |
|---|---|---|
| 没有 macOS 构建机 | Gitee Go 提供 Linux / Windows 构建机，macOS 不在常规套餐内 | `.dmg` / `.app.tar.gz` 只能在 macOS 上打 |
| 额度不够 | 单仓库 200 构建分钟/月（企业版 1000） | 一次双平台 Tauri 打包 ≈ 25–40 分钟，重跑翻倍 |
| 没有 tauri-action | GitHub 侧一条 action 完成打包 + 建 Release + 传资产 + 回填签名 | Gitee Go 需自己写 shell 拼整套流程 |

因此采用既定退路：**GitHub 构建 → 自动拉回产物 → 上传 Gitee Release**，无需人工搬运。

> 若将来 Gitee Go 开放 macOS 构建机且额度够用，只需新增 `.workflow/release.yml`，
> 把 `pnpm tauri build` 与 `node scripts/gitee-release.mjs --assets-dir <bundle>` 串起来，本文其余部分不变。

---

## 2. 发布链路

```
git tag v2.1.0 && git push origin v2.1.0
        │
        ├─ build（macos-latest / windows-latest）→ Release 附件 .dmg / .app.tar.gz / -setup.exe / *.sig
        ├─ publish-manifest → latest.json（darwin 双键同指 universal 包）
        └─ publish-gitee → node scripts/gitee-release.mjs --tag v2.1.0
              ├─ 正文取 release-notes/v2.1.0.md
              ├─ 从 GitHub 下载 6 个产物（API asset 端点，带大小校验）
              ├─ Gitee 建/更新 release（tag 不存在时按 target_commitish 建）
              └─ 逐个 attach_files 上传（同名已存在则跳过）
```

| 文件 | 用途 | 是否镜像 |
|---|---|---|
| `Tree.Todo_<ver>_universal.dmg` | macOS 安装包 | ✅ |
| `Tree.Todo_<ver>_x64-setup.exe` | Windows 安装包（NSIS） | ✅ |
| `Tree.Todo_<ver>_universal.app.tar.gz` | macOS 应用内更新包 | ✅ |
| `*.sig` | 更新包签名（Ed25519） | ✅ |
| `latest.json` | 更新清单 | ✅（其中 URL 仍指向 GitHub，见 §6） |

### 2.1 执行时机（为什么不会抢跑）

`publish-gitee` 声明了 `needs: [build, publish-manifest]`，GitHub Actions 的语义保证：

| 机制 | 效果 |
|---|---|
| `needs: build`（matrix job） | 等 macOS + Windows **所有矩阵腿**全部成功才继续 |
| `tauri-action` 在 `build` 内部完成上传 | `build` 变绿 ⇒ `.dmg` / `-setup.exe` / `.app.tar.gz` / `*.sig` 已经在 Release 里 |
| `needs: publish-manifest` | 该 job 最后一步才上传 `latest.json`，等它 ⇒ 清单也已就位 |
| 上游任一 job 失败 | `publish-gitee` 直接 skipped（默认 `needs` 语义），不会传半套产物 |

即便如此，“等到了”不等于“凑齐了”（例如签名密钥没配导致 `.sig` 缺失），所以 CI 里调用时带
`--require-complete`：6 类产物缺任何一类就失败，且**在创建 release 之前**就失败，不会在 Gitee 上留残缺版本。

---

## 3. 一次性配置

### 3.1 仓库远端

```bash
git remote add gitee git@gitee.com:Jeysin/tree-todo.git   # 已配置
git push gitee main --tags                                # 首次同步代码与历史 tag
```

### 3.2 Gitee 私人令牌

Gitee → 头像 → **设置** → **私人令牌** → 生成，权限勾选 **projects**。
令牌只显示一次，复制后立刻保存或直接写入 GitHub Secret。

```bash
curl -s "https://gitee.com/api/v5/user?access_token=$GITEE_TOKEN" | head -c 200   # 返回 login 即有效
```

### 3.3 GitHub 仓库密钥

GitHub → 仓库 → **Settings → Secrets and variables → Actions → New repository secret**：

| Name | Value |
|---|---|
| `GITEE_TOKEN` | 上一步的令牌 |

未配置时 `publish-gitee` 只打一条 notice 并跳过，不会让发布失败。

---

## 4. 日常使用

### 4.1 发新版本（全自动）

```bash
# 1) 改版本号：package.json / src-tauri/tauri.conf.json / CHANGELOG.md
# 2) 写 release-notes/v2.1.0.md（同时作为 GitHub 与 Gitee 的 release 正文）
git tag v2.1.0 && git push origin v2.1.0
git push gitee main --tags    # 可选：让 Gitee 也有 tag
```

### 4.2 补传 / 重传（不重新构建）

GitHub → **Actions** → **Mirror release to Gitee** → **Run workflow**：填 `tag`，按需勾 `overwrite` / `prerelease`。

本地等价：

```bash
export GITEE_TOKEN=xxx
pnpm release:gitee --tag v2.0.0                  # 从 GitHub 下载后上传
pnpm release:gitee --tag v2.0.0 --dry-run        # 只打印计划
pnpm release:gitee --tag v2.0.0 --assets-dir ./release-assets   # 用本地已有产物
pnpm release:gitee --tag v2.0.0 --overwrite      # 删 release 重建后全量重传
pnpm release:gitee --tag v2.0.0 --require-complete   # 先校验 6 类产物齐全再传
```

退出码：`0` 成功，`1` 接口/参数错误，`2` 缺 `GITEE_TOKEN`。

> ⚠️ **Gitee 的「最新版」按 release 创建时间判定，与版本号无关**：批量补传历史版本必须**按版本升序**执行，
> 否则老版本会抢走「最新版」。已经顺序错了的话，`--overwrite` 重建高版本即可把它顶回首位（附件会全量重传）。

### 4.3 校验

```bash
curl -s "https://gitee.com/api/v5/repos/Jeysin/tree-todo/releases/tags/v2.0.0" \
  | python3 -c "import json,sys; [print(a['name']) for a in json.load(sys.stdin)['assets']]"
```

应看到 6 个附件（Gitee 另附 `vX.Y.Z.zip` / `.tar.gz` 源码包，属正常）。
下载地址形如 `https://gitee.com/Jeysin/tree-todo/releases/download/v2.0.0/<文件名>`，公开仓库匿名可下。

---

## 5. 已知限制

| 限制 | 影响 | 应对 |
|---|---|---|
| 单附件 100MB 上限 | 超出的文件被跳过 | 脚本明确告警；当前最大 8.4MB |
| 附件无法原地替换（API 不返回附件 id） | 同名文件只能跳过或整体重建 | `--overwrite` 走「删 release → 重建 → 全量重传」 |
| release 正文取 `release-notes/<tag>.md` | 缺失时回退 GitHub 正文 | 发版清单保留该步骤 |
| 大文件上传偶发 `EPIPE` | 单次上传可能断 | 脚本 5 次重试 + `curl` 兜底 |
| GitHub 产物直链在国内不稳 | 本地镜像可能超时 | 脚本优先走 `api.github.com/.../assets/<id>`（走 302，对代理友好），失败回落直链 |

---

## 6. 为什么不顺手把更新源也换成 Gitee

应用内自动更新（`docs/08`）读的是 `https://github.com/Jeysin/tree-todo/releases/latest/download/latest.json`。把 Gitee 加成第二个 endpoint 看似能帮国内用户，但当前不成立：

1. Gitee 上的 `latest.json` 是**同一个文件**，其中 `url` 仍指向 GitHub 资产 → 清单能拉到，包照样下不动；
2. 要让 Gitee 版清单指向 Gitee 资产，就得维护两份清单，而 Gitee 附件下载链路无 CDN 保障，体验未必更好；
3. macOS 包未签名公证，本来就跳「前往下载」，国内用户从 Gitee 页面下载即可覆盖主要诉求。

所以本期定位：**Gitee = 下载渠道，GitHub = 更新渠道**。若后续要接 Gitee 更新源，改动点是
`scripts/updater-manifest.mjs` 产出第二份清单 + `src-tauri/tauri.conf.json` 增加 endpoint，需单独验证。

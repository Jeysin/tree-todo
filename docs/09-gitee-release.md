# 09 · Gitee 发布与安装包分发

> 状态：**已实施**（2026-11-04）；2026-11-15 依 v2.1.0 实测把镜像改回本机执行（§7）
>
> 关联：`docs/08-auto-update.md`（更新源仍是 GitHub Releases）、`.github/workflows/release.yml`、`scripts/gitee-release.mjs`
>
> 目标：代码托管在 Gitee（`git@gitee.com:Jeysin/tree-todo.git`），安装包在 Gitee Release 上可直接下载。

---

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| 用 Gitee 的 CI 构建安装包？ | **不行**，见 §1 |
| 安装包谁构建？ | GitHub Actions（`release.yml`），三平台原生 runner |
| Gitee 侧做什么？ | 代码镜像 + **Release 产物镜像**（`scripts/gitee-release.mjs`） |
| 什么时候镜像？ | **发版后在本机执行** `pnpm release:gitee --tag vX.Y.Z`；不放进 GitHub Actions（§7） |
| 为什么不自动？ | GitHub 的 runner 在海外，往 gitee.com 传大文件会被跨境链路卡死，v2.1.0 实测 40 分钟没传完一个 4.58MB 的 `.rpm`（§7） |
| 下载页 | `https://gitee.com/Jeysin/tree-todo/releases` |
| 应用内自动更新从哪拉？ | 仍是 GitHub 的 `latest.json`；Gitee 只做分发（§6） |

**一句话**：GitHub 负责「构建」，Gitee 负责「在国内能下载到」。

---

## 1. 为什么不在 Gitee 上构建

Gitee 的 CI 是 **Gitee Go**（`.workflow/*.yml` 的流水线式 YAML，插件体系与 GitHub Actions 不同）。对本项目有三条硬约束：

| 约束 | 事实 | 影响 |
|---|---|---|
| 没有 macOS 构建机 | Gitee Go 提供 Linux / Windows 构建机，macOS 不在常规套餐内 | `.dmg` / `.app.tar.gz` 只能在 macOS 上打 |
| 额度不够 | 单仓库 200 构建分钟/月（企业版 1000） | 一次三平台 Tauri 打包 ≈ 40–60 分钟，重跑翻倍 |
| 没有 tauri-action | GitHub 侧一条 action 完成打包 + 建 Release + 传资产 + 回填签名 | Gitee Go 需自己写 shell 拼整套流程 |

因此采用既定退路：**GitHub 构建 → 拉回产物 → 上传 Gitee Release**。最后这步搬运由本机一条命令完成（§4.1），不放进 CI——原因见 §7，不是偷懒，是这条路走不通。

> 若将来 Gitee Go 开放 macOS 构建机且额度够用，只需新增 `.workflow/release.yml`，
> 把 `pnpm tauri build` 与 `node scripts/gitee-release.mjs --assets-dir <bundle>` 串起来，本文其余部分不变。

---

## 2. 发布链路

```
git tag v2.1.0 && git push origin v2.1.0
        │
        ├─ build（macos-latest / windows-latest / ubuntu-22.04）→ Release 附件
        │    .dmg / .app.tar.gz / -setup.exe / .deb / .rpm / .AppImage / *.sig
        └─ publish-manifest → latest.json（darwin 双键同指 universal 包，另含 linux-x86_64）

# ↑ 等上面全部变绿之后，在本机（国内网络）执行：
pnpm release:gitee --tag v2.1.0 --require-complete
        ├─ 正文取 release-notes/v2.1.0.md
        ├─ 从 GitHub 下载 10 个产物（API asset 端点，带大小校验）
        ├─ Gitee 建/更新 release（tag 不存在时按 target_commitish 建）
        └─ 逐个 attach_files 上传（同名已存在则跳过）
```

| 文件 | 用途 | 是否镜像 |
|---|---|---|
| `Tree.Todo_<ver>_universal.dmg` | macOS 安装包 | ✅ |
| `Tree.Todo_<ver>_x64-setup.exe` | Windows 安装包（NSIS） | ✅ |
| `Tree.Todo_<ver>_universal.app.tar.gz` | macOS 应用内更新包 | ✅ |
| `*.deb` | Linux（Ubuntu / Debian）安装包 | ✅ |
| `*.rpm` | Linux（Fedora / RHEL）安装包 | ✅ |
| `*.AppImage` | Linux 便携版，同时是 Linux updater 载体 | ✅ |
| `*.sig` | 更新包签名（Ed25519，含 `.AppImage.sig`） | ✅ |
| `latest.json` | 更新清单 | ✅（其中 URL 仍指向 GitHub，见 §6） |

### 2.1 执行时机（为什么不会传半套）

改成手动执行后，`needs:` 那层自动等待就没有了，靠两条替代约束：

| 约束 | 作用 |
|---|---|
| 人工检查点 | 等 Actions 里三腿 `build` 与 `publish-manifest` **全部变绿**再执行。`tauri-action` 在 `build` 内部完成上传，`latest.json` 由 `publish-manifest` 最后一步上传，全绿即产物齐备 |
| `--require-complete` | 「等到了」不等于「凑齐了」（例如签名密钥没配导致 `.sig` 缺失）。10 类产物缺任何一类直接失败（含 `.deb` / `.rpm` / `.AppImage` / `.AppImage.sig`），且**在创建 release 之前**就失败，不会在 Gitee 上留残缺版本 |

漏了第一条也不会坏事：第二条会在上传前拦住，只是白下载一次。

---

## 3. 一次性配置

### 3.1 仓库远端

```bash
git remote add gitee git@gitee.com:Jeysin/tree-todo.git   # 已配置
git push gitee main --tags                                # 首次同步代码与历史 tag
```

### 3.2 Gitee 私人令牌

Gitee → 头像 → **设置** → **私人令牌** → 生成，权限勾选 **projects**。
令牌只显示一次，复制后立刻存到本机的私密配置里（§3.3）。

> 手上已经找不到这枚令牌了？Gitee 不支持回看，最省事的做法是**重新生成一枚、删掉旧的**，
> 反正它只在这台机器上用，不影响任何 CI。

```bash
# 存进钥匙串后（§3.3）据此校验，返回 login 即有效
curl -s "https://gitee.com/api/v5/user?access_token=$(security find-generic-password -s tree-todo-gitee -w)" | head -c 200
```

### 3.3 令牌放哪：macOS 钥匙串（存一次，之后不用管）

令牌一年只用几次，**真正的风险不是泄漏而是忘了放哪**。所以位置固定为钥匙串服务名
`tree-todo-gitee`，脚本自己去取，不依赖 shell 里有没有 `export`：

```bash
# 存：-w 放在最后，security 会提示输入两遍，令牌不会落进 shell 历史
security add-generic-password -s tree-todo-gitee -a "$USER" -U -w

# 以后忘了在哪，一条命令找回
security find-generic-password -s tree-todo-gitee -w
```

（`-U` = 已存在则覆盖，可反复执行。若你不在意历史记录，也可以直接把值写在 `-w` 后面。）

图形界面里同样找得到：**钥匙串访问 → 搜索 `tree-todo-gitee`**（类别为「密码」）。

> 为什么不是 `~/.zshrc`：那是明文，会进 Time Machine / iCloud 备份，且每个子进程都能读到；
> 更麻烦的是复制令牌时容易顺手粘进终端，落进 `~/.zsh_history`。钥匙串由系统加密保管，
> 只在本机、只在登录态可解。

脚本的解析顺序（前一处命中即停，所以临时换号只需设环境变量，不必改钥匙串）：

| 顺序 | 来源 | 用途 |
|---|---|---|
| 1 | 环境变量 `GITEE_TOKEN` | 临时换号 / CI |
| 2 | `GITEE_TOKEN_FILE` 指向的文件 | 想用文件时 |
| 3 | macOS 钥匙串 `tree-todo-gitee` | **推荐，日常用这个** |
| 4 | `~/.config/tree-todo/gitee.env` | 非 macOS 或不想用钥匙串时的兜底 |

第 4 项写法（记得 `chmod 600`）：

```bash
mkdir -p ~/.config/tree-todo && printf 'GITEE_TOKEN=%s\n' "你的令牌" > ~/.config/tree-todo/gitee.env
chmod 600 ~/.config/tree-todo/gitee.env
```

验证通了会有明确回显，不用猜是读到了哪一份：

```bash
pnpm release:gitee --tag v2.1.0 --dry-run
# [gitee-release] 令牌来源：macOS 钥匙串
```

> 如果你之前配过仓库 Secret `GITEE_TOKEN`，现在**没有任何工作流引用它，建议删掉**：
> 一枚长期有效、带 `projects` 写权限的令牌不该躺在 CI 里。删掉不影响本机执行。
> 若曾把令牌粘进终端，顺手清一下：`grep -n GITEE_TOKEN ~/.zsh_history`，有就删掉那几行。

---

## 4. 日常使用

### 4.1 发新版本

```bash
# 1) 改版本号：package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json / Cargo.lock
# 2) 写 release-notes/v2.1.0.md（同时作为 GitHub 与 Gitee 的 release 正文）
git tag v2.1.0 && git push origin v2.1.0

# 3) 等 Actions 的 build（三腿）+ Publish updater manifest 全绿
# 4) 在本机补 Gitee（国内网络，见 §7 为什么不在 CI 里做）
#    令牌已在钥匙串里，无需 export（§3.3）
pnpm release:gitee --tag v2.1.0 --require-complete

git push gitee main --tags    # 可选：让 Gitee 仓库也有 tag
```

10 个附件、109MB 左右，正常 20 秒到 1 分钟。脚本会打印每个附件的**耗时与速率**，
所以下次万一变慢，日志本身就能说明是「慢」还是「卡住」。

#### 产物不留在本地磁盘

从 GitHub 拉回来的产物落在 `$TMPDIR/tree-todo-gitee-xxxxxx`（macOS 上即
`/var/folders/.../T/`），**脚本结束时整目录删掉**——成功、失败、Ctrl-C 三条路径都清：

| 情形 | 临时目录 |
|---|---|
| 正常上传完成 | 删除 |
| 校验不齐、上传失败、令牌无效 | 删除（错误信息照常打印，退出码仍为 1） |
| Ctrl-C / `kill` | 删除（收到信号先清再退出，退出码 130） |
| `kill -9`、断电、崩溃 | 当次清不掉；**下次运行开头会清**（只删 1 小时前的，避免误删同时跑的第二份） |
| 用 `--assets-dir` | 不创建临时目录，也不碰你指定的目录 |

启动时日志里有一行 `临时目录：…（结束自动删除）`，想确认就盯着它。真占空间的是
AppImage 那 79MB，跑完不删的话一天试几次就上 G 了，所以这条是刻意做的。

> 要留一份本地备份的话，用 `--assets-dir ./release-assets` 先把产物存到自己的目录，
> 脚本只读不删。

### 4.2 补传 / 重传（不重新构建）

```bash
pnpm release:gitee --tag v2.0.0                  # 从 GitHub 下载后上传；已存在的附件跳过
pnpm release:gitee --tag v2.0.0 --dry-run        # 只打印计划
pnpm release:gitee --tag v2.0.0 --assets-dir ./release-assets   # 用本地已有产物
pnpm release:gitee --tag v2.0.0 --overwrite      # 删 release 重建后全量重传
pnpm release:gitee --tag v2.0.0 --require-complete   # 先校验 10 类产物齐全再传
```

脚本是幂等的：重跑只补缺的附件，可以放心多跑几次。

退出码：`0` 成功，`1` 接口/参数错误，`2` 缺 `GITEE_TOKEN`。

> ⚠️ **Gitee 的「最新版」按 release 创建时间判定，与版本号无关**：批量补传历史版本必须**按版本升序**执行，
> 否则老版本会抢走「最新版」。已经顺序错了的话，`--overwrite` 重建高版本即可把它顶回首位（附件会全量重传）。

### 4.3 校验

```bash
curl -s "https://gitee.com/api/v5/repos/Jeysin/tree-todo/releases/tags/v2.0.0" \
  | python3 -c "import json,sys; [print(a['name']) for a in json.load(sys.stdin)['assets']]"
```

应看到 10 个附件（Gitee 另附 `vX.Y.Z.zip` / `.tar.gz` 源码包，属正常）。
下载地址形如 `https://gitee.com/Jeysin/tree-todo/releases/download/v2.0.0/<文件名>`，公开仓库匿名可下。

---

## 5. 已知限制

| 限制 | 影响 | 应对 |
|---|---|---|
| **GitHub runner 传不动 Gitee** | 海外出口到 gitee.com 的上传会卡死（<2KB/s，甚至归零） | 镜像不放进 CI，改为发版后本机执行，见 §7 |
| 单附件 100MB 上限 | 超出的文件被跳过 | AppImage 约 70MB，仍在限内；`--require-complete` 下必需产物超限会直接失败，避免 Gitee 上缺附件 |
| 附件无法原地替换（API 不返回附件 id） | 同名文件只能跳过或整体重建 | `--overwrite` 走「删 release → 重建 → 全量重传」 |
| release 正文取 `release-notes/<tag>.md` | 缺失时回退 GitHub 正文 | 发版清单保留该步骤 |
| 大文件上传偶发 `EPIPE` | 单次上传可能断 | 3 次重试（每次 20 分钟硬超时）+ `curl` 兜底 |
| GitHub 产物直链在国内不稳 | 本地镜像可能超时 | 脚本优先走 `api.github.com/.../assets/<id>`（走 302，对代理友好），失败回落直链 |

---

## 6. 为什么不顺手把更新源也换成 Gitee

应用内自动更新（`docs/08`）读的是 `https://github.com/Jeysin/tree-todo/releases/latest/download/latest.json`。把 Gitee 加成第二个 endpoint 看似能帮国内用户，但当前不成立：

1. Gitee 上的 `latest.json` 是**同一个文件**，其中 `url` 仍指向 GitHub 资产 → 清单能拉到，包照样下不动；
2. 要让 Gitee 版清单指向 Gitee 资产，就得维护两份清单，而 Gitee 附件下载链路无 CDN 保障，体验未必更好；
3. macOS 包未签名公证，本来就跳「前往下载」，国内用户从 Gitee 页面下载即可覆盖主要诉求。

所以本期定位：**Gitee = 下载渠道，GitHub = 更新渠道**。若后续要接 Gitee 更新源，改动点是
`scripts/updater-manifest.mjs` 产出第二份清单 + `src-tauri/tauri.conf.json` 增加 endpoint，需单独验证。

---

## 7. 为什么 Gitee 镜像不在 CI 里跑（v2.1.0 实测）

**结论**：GitHub Actions 的 runner 全在海外，往 gitee.com 上传大文件会被跨境链路卡死。
这是链路层问题，客户端加超时、加重试、换 `curl` 都救不回来。所以镜像改回本机执行。

### 7.1 事故现场

v2.1.0 是**第一次**真的在 CI 里跑这个 job。v1.0.0 / v2.0.0 在 Gitee 上也有完整附件，
但那都是本机跑脚本传的——当时 `release.yml` 里还没有这个 job，手动的 `gitee-mirror.yml`
一次都没被触发过。也就是说这条自动路径**从未验证过**，首发就现形：

| 时刻（UTC） | 事件 |
|---|---|
| 16:07:09 | `Mirror to Gitee` job 启动 |
| 16:07:21 | Gitee 上 release 建好 → **109MB / 12 个产物下载只用 10 秒**（Azure 内部，很快） |
| 16:07:22 起 | 逐个上传：1KB 的 `latest.json` 成功 |
| … | 4.58MB 的 `Tree.Todo-2.1.0-1.x86_64.rpm` 一直没传完 |
| 16:47:21 | 撞上 `timeout-minutes: 40` 被取消，Gitee 上只剩 1 个附件 |

40 分钟传不完 4.58MB，折算 **<2KB/s**。不是「慢」，是**卡住**。

### 7.2 横向对照

| 出口 | 4MB 上传 | 结论 |
|---|---|---|
| 本机（国内） | 0.77s（5.4MB/s） | 正常 |
| GitHub runner（海外） | 39 分钟没传完一个 4.58MB 文件 | 不可用 |
| 社区实测（多个仓库） | 13.8KB/s 一路衰减到 0，1MB 都传不完；另一份记录 20–90KB/s，几十 MB 常被掐断 | 与本次一致 |

所以既不是本项目独有的偶发问题，也不是 Node `fetch` / `FormData` 的实现问题——脚本当时已内置
5 次重试 + `curl` 兜底，全部无效。

### 7.3 现在的做法

- `release.yml` 里**没有** Gitee job：构建与 `latest.json` 走 GitHub，Gitee 由发版后一条本地命令补齐（§4.1）。
- 手动工作流 `gitee-mirror.yml` 一并删除——它跑在同一条卡死的链路上，只会再演一次 40 分钟红叉。补传历史版本用 §4.2 的本地命令。
- 脚本给每次上传加了 **20 分钟硬超时**，并打印每个附件的**耗时与速率**：下次再变慢，日志本身就能区分「慢」和「卡住」，不用再靠时间线反推。

### 7.4 如果将来想恢复自动化

前提只有一个：**从国内出口上传**。三条路各有代价：

| 方案 | 可行性 | 代价 |
|---|---|---|
| 自建 runner（一台国内机器） | 可行 | **公网仓库别用**：fork 的 PR 能在 runner 上执行任意代码，等于把机器交出去；只适合私有仓库 |
| 国内托管 CI（CNB / Gitee Go 等） | 待验证 | 需确认它能稳定拉取 GitHub Release 资产（国内访问 GitHub 是另一个方向的坑），还要维护第二套流水线 |
| 国内对象存储 + 反向代理 | 可行 | 多一个域名与成本，还要处理 Releases 页面和下载链接的一致性 |

在一名维护者、一两个月发一次版的前提下，本地一条命令（约 20 秒）比上面任何方案都便宜，
所以本期就停在这里。

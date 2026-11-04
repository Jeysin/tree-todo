/**
 * 把 GitHub Release 的安装包镜像到 Gitee Release。
 *
 * 为什么是「镜像」而不是「在 Gitee 上构建」：
 *   本项目要产出 .dmg / .app.tar.gz（macOS）与 -setup.exe（NSIS，Windows），
 *   Tauri 打包只能在对应原生系统上完成；Gitee Go 只提供 Linux/Windows 构建机
 *   （无 macOS），额度 200 构建分钟/仓库/月，也远不够一次双平台打包。
 *   所以安装包由 GitHub Actions 构建，本脚本负责把产物搬到 Gitee Release。
 *   方案与限制见 docs/09-gitee-release.md。
 *
 * 用法（本地或 CI）：
 *   GITEE_TOKEN=xxx node scripts/gitee-release.mjs --tag v2.0.0
 *   GITEE_TOKEN=xxx node scripts/gitee-release.mjs --tag v2.0.0 --assets-dir ./release-assets
 *   GITEE_TOKEN=xxx node scripts/gitee-release.mjs --tag v2.0.0 --dry-run
 *
 * 参数：
 *   --tag <vX.Y.Z>       必填（也可用 TAG / GITHUB_REF_NAME）
 *   --assets-dir <dir>   用本地已有产物，跳过从 GitHub 下载
 *   --overwrite          同名附件已存在时删除 release 后重建并全量重传
 *   --require-complete   校验 6 类产物齐全（dmg / app.tar.gz + 两个 sig / exe / latest.json），
 *                        缺任何一类直接失败；release.yml 自动镜像时会带上
 *   --prerelease         在 Gitee 上标记为预发布
 *   --dry-run            只打印计划，不发写请求
 *   --repo <owner/repo>  Gitee 仓库，默认 GITEE_REPO 或 Jeysin/tree-todo
 *   --source-repo <o/r>  产物来源仓库，默认 GITHUB_REPOSITORY 或 Jeysin/tree-todo
 *   --target <branch>    Gitee 侧建 tag 用的分支，默认 main 失败回落 master
 *
 * 退出码：0 成功；1 参数或接口错误；2 缺少 GITEE_TOKEN。
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const GITEE_API = 'https://gitee.com/api/v5';
const GITHUB_API = 'https://api.github.com';
/** Gitee 单附件上限 100MB，超出的文件跳过并告警。 */
const GITEE_MAX_ASSET_BYTES = 100 * 1024 * 1024;
/** 上传重试次数；Gitee 大文件上传偶发 EPIPE，靠重试 + curl 兜底。 */
const UPLOAD_ATTEMPTS = 5;

/** 需要镜像的产物：安装包本体、更新包、签名、更新清单。 */
const ASSET_PATTERNS = [/\.dmg$/i, /-setup\.exe$/i, /\.app\.tar\.gz$/i, /\.sig$/i, /^latest\.json$/i];

/**
 * 一次完整发布必须凑齐的产物组。用 --require-complete 开启：
 * 上游打包慢且容易半途出错（少了签名、latest.json 没生成），
 * 与其把残缺的一组传到 Gitee，不如直接失败让人看见。
 */
const REQUIRED_GROUPS = [
  { label: 'macOS 安装包 (.dmg)', match: /\.dmg$/i },
  { label: 'macOS 更新包 (.app.tar.gz)', match: /\.app\.tar\.gz$/i },
  { label: 'macOS 更新包签名 (.app.tar.gz.sig)', match: /\.app\.tar\.gz\.sig$/i },
  { label: 'Windows 安装包 (-setup.exe)', match: /-setup\.exe$/i },
  { label: 'Windows 安装包签名 (-setup.exe.sig)', match: /-setup\.exe\.sig$/i },
  { label: '更新清单 (latest.json)', match: /^latest\.json$/i },
];

const args = parseArgs(process.argv.slice(2));
const tag = args.tag || process.env.TAG || process.env.GITHUB_REF_NAME;
const giteeRepo = args.repo || process.env.GITEE_REPO || 'Jeysin/tree-todo';
const sourceRepo = args['source-repo'] || process.env.GITHUB_REPOSITORY || 'Jeysin/tree-todo';
const token = process.env.GITEE_TOKEN || '';
const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

const dryRun = args.flags.has('dry-run');
const overwrite = args.flags.has('overwrite');
const prerelease = args.flags.has('prerelease');
const requireComplete = args.flags.has('require-complete');
const releaseUrl = `https://gitee.com/${giteeRepo}/releases/tag/${tag}`;

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out.flags.add(key);
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function fail(message) {
  console.error(`[gitee-release] ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[gitee-release] ${message}`);
}

function humanSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (!tag) fail('缺少 --tag（或 TAG / GITHUB_REF_NAME）');
if (!/^v\d+\.\d+\.\d+/.test(tag)) fail(`tag 需要形如 vX.Y.Z，当前为 ${tag}`);
if (!token) {
  console.error('[gitee-release] 缺少 GITEE_TOKEN，跳过 Gitee 镜像。');
  console.error('  生成方式：Gitee → 设置 → 私人令牌 → 勾选 projects，然后 export GITEE_TOKEN=xxx');
  process.exit(2);
}

/** Gitee OpenAPI 统一入口：token 走 query，避免 multipart 里塞字段的兼容问题。 */
async function gitee(path, init = {}) {
  const url = new URL(`${GITEE_API}${path}`);
  url.searchParams.set('access_token', token);
  const headers = { ...(init.headers || {}) };
  if (init.json !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method: init.method || 'GET',
    headers,
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { ok: response.ok, status: response.status, data };
}

async function githubRelease() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;
  const response = await fetch(`${GITHUB_API}/repos/${sourceRepo}/releases/tags/${tag}`, { headers });
  if (!response.ok) return null;
  return response.json();
}

/** 读取发布说明：优先 release-notes/<tag>.md，其次 GitHub Release 正文。 */
async function resolveNotes() {
  const local = `release-notes/${tag}.md`;
  if (existsSync(local)) {
    const body = readFileSync(local, 'utf8').trim();
    if (body) return { body, from: local };
  }
  const gh = await githubRelease();
  if (gh && typeof gh.body === 'string' && gh.body.trim()) {
    return { body: gh.body.trim(), from: 'GitHub Release 正文' };
  }
  return { body: `Tree Todo ${tag.replace(/^v/, '')}`, from: '默认占位' };
}

/** 下载单个资产：先用 API 的 octet-stream 端点（走 302，对代理更友好），失败回落直链。 */
async function downloadAsset(asset, dest) {
  const headers = { Accept: 'application/octet-stream' };
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;
  const urls = [
    `${GITHUB_API}/repos/${sourceRepo}/releases/assets/${asset.id}`,
    asset.browser_download_url,
  ];

  let lastError = '';
  for (const url of urls) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(url, { headers, redirect: 'follow' });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
        const size = statSync(dest).size;
        if (size !== asset.size) throw new Error(`大小不符：期望 ${asset.size}，实际 ${size}`);
        return size;
      } catch (error) {
        lastError = `${url} → ${error.message}`;
        await sleep(attempt * 1500);
      }
    }
  }
  fail(`下载 ${asset.name} 失败：${lastError}`);
}

/** 从 GitHub Release 拉取需要镜像的资产到临时目录。 */
async function downloadAll(targetDir) {
  const release = await githubRelease();
  if (!release) fail(`GitHub 上找不到 ${sourceRepo} 的 release ${tag}`);

  const wanted = (release.assets || []).filter(asset => ASSET_PATTERNS.some(re => re.test(asset.name)));
  if (wanted.length === 0) fail(`${tag} 没有任何可镜像的安装包资产`);

  const files = [];
  for (const asset of wanted) {
    const dest = join(targetDir, asset.name);
    if (dryRun) {
      log(`[dry-run] 将下载 ${asset.name}（${humanSize(asset.size)}）`);
      files.push({ path: dest, name: asset.name, size: asset.size });
      continue;
    }
    const size = await downloadAsset(asset, dest);
    files.push({ path: dest, name: asset.name, size });
    log(`已下载 ${asset.name}（${humanSize(size)}）`);
  }
  log(`产物来源：GitHub ${sourceRepo}@${tag}，共 ${files.length} 个文件`);
  return files;
}

/** 读取本地目录中的产物（CI 里 artifact 已落地、或产物已手工下载时用）。 */
function collectLocalAssets(dir) {
  if (!existsSync(dir)) fail(`--assets-dir 不存在：${dir}`);
  const files = readdirSync(dir)
    .filter(name => ASSET_PATTERNS.some(re => re.test(name)))
    .map(name => join(dir, name))
    .filter(path => statSync(path).isFile())
    .map(path => ({ path, name: basename(path), size: statSync(path).size }));
  if (files.length === 0) fail(`${dir} 里没有可镜像的安装包`);
  log(`产物来源：本地目录 ${dir}，共 ${files.length} 个文件`);
  return files;
}

/** 找到或新建 Gitee Release，并把正文同步为最新发布说明。 */
async function ensureRelease(body) {
  const existing = await gitee(`/repos/${giteeRepo}/releases/tags/${tag}`);
  // tag 在 Gitee 上不存在时接口按 target_commitish 建 tag；默认分支可能是 main 或 master，未指定就都试一次
  const explicitTarget = args.target || process.env.GITEE_TARGET;
  const targets = explicitTarget ? [explicitTarget] : ['main', 'master'];
  const base = { tag_name: tag, name: `Tree Todo ${tag.replace(/^v/, '')}`, body, prerelease };

  if (existing.ok && existing.data && existing.data.id) {
    const id = existing.data.id;
    log(`Gitee 上已存在 release ${tag}（id=${id}），同步正文`);
    if (dryRun) return { id, created: false };
    const updated = await gitee(`/repos/${giteeRepo}/releases/${id}`, { method: 'PATCH', json: base });
    if (!updated.ok) fail(`更新 release 失败：HTTP ${updated.status} ${JSON.stringify(updated.data)}`);
    return { id, created: false };
  }

  if (existing.status === 401 || existing.status === 403) {
    fail(`GITEE_TOKEN 无效或权限不足：${JSON.stringify(existing.data).slice(0, 200)}`);
  }

  // Gitee 对「release 不存在」的返回是 404 或 200 + null，两种都算没有
  const notFound = existing.status === 404 || existing.data === null || existing.data === undefined;
  if (!notFound && !existing.ok) {
    log(`查询 release 返回 HTTP ${existing.status}：${JSON.stringify(existing.data).slice(0, 200)}`);
  }

  log(`在 Gitee 上创建 release ${tag}`);
  if (dryRun) return { id: null, created: true };

  let lastStatus = 0;
  let lastData = null;
  for (const target of targets) {
    const created = await gitee(`/repos/${giteeRepo}/releases`, {
      method: 'POST',
      json: { ...base, target_commitish: target },
    });
    if (created.ok && created.data?.id) return { id: created.data.id, created: true };
    lastStatus = created.status;
    lastData = created.data;
    log(`用 target_commitish=${target} 创建失败（HTTP ${created.status}）`);
  }
  fail(
    `创建 release 失败：HTTP ${lastStatus} ${JSON.stringify(lastData)}\n` +
      '  常见原因：Gitee 仓库还没有代码/分支。先执行 git push gitee main --tags 再重试。',
  );
}

/** 查询已上传附件。Gitee 只返回 name + browser_download_url，没有附件 id。 */
async function listAttachments(releaseId) {
  const response = await gitee(`/repos/${giteeRepo}/releases/${releaseId}`);
  if (!response.ok) fail(`读取 release 详情失败：HTTP ${response.status}`);
  return Array.isArray(response.data?.assets) ? response.data.assets : [];
}

/** 上传单个附件：fetch 重试若干次，仍失败则用 curl 兜底（对大 body 更稳）。 */
async function uploadAttachment(releaseId, file) {
  const buffer = readFileSync(file.path);
  const url = new URL(`${GITEE_API}/repos/${giteeRepo}/releases/${releaseId}/attach_files`);
  url.searchParams.set('access_token', token);

  let lastError = '';
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      // 每次重试都重建 FormData：body 写坏后不可复用
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), file.name);
      const response = await fetch(url, { method: 'POST', body: form });
      const text = await response.text();
      if (response.ok) return true;
      lastError = `HTTP ${response.status} ${text.slice(0, 200)}`;
    } catch (error) {
      // EPIPE / ECONNRESET 等网络层错误也走重试
      lastError = String(error && error.cause ? error.cause.code || error.cause.message : error);
    }
    log(`上传 ${file.name} 第 ${attempt} 次失败：${lastError}`);
    if (attempt < UPLOAD_ATTEMPTS) await sleep(attempt * 3000);
  }

  log(`改用 curl 重试 ${file.name}`);
  try {
    execFileSync(
      'curl',
      [
        '-sS', '--fail', '--retry', '3', '--retry-delay', '2',
        '--connect-timeout', '30', '--max-time', '900',
        '-F', `file=@${file.path}`, url.toString(),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return true;
  } catch (error) {
    log(`curl 上传 ${file.name} 失败：${error.message}`);
    return false;
  }
}

async function main() {
  const notes = await resolveNotes();
  log(`发布说明来源：${notes.from}`);

  const tempDir = args['assets-dir'] ? null : mkdtempSync(join(tmpdir(), 'tree-todo-gitee-'));
  try {
    const files = args['assets-dir'] ? collectLocalAssets(args['assets-dir']) : await downloadAll(tempDir);

    if (requireComplete) {
      const missing = REQUIRED_GROUPS.filter(group => !files.some(file => group.match.test(file.name)));
      if (missing.length > 0) {
        fail(
          `产物不完整（--require-complete）：缺 ${missing.map(group => group.label).join('、')}\n` +
            `  实际拿到：${files.map(file => file.name).join(', ') || '（无）'}`,
        );
      }
      log(`产物齐全校验通过：${REQUIRED_GROUPS.length} 类产物全部就位`);
    }

    for (const file of files.filter(item => item.size > GITEE_MAX_ASSET_BYTES)) {
      log(`跳过 ${file.name}：${humanSize(file.size)} 超过 Gitee 单附件 100MB 上限`);
    }
    const uploadable = files.filter(file => file.size <= GITEE_MAX_ASSET_BYTES);
    if (uploadable.length === 0) fail('没有可上传的附件（全部超出 Gitee 限制）');

    let release = await ensureRelease(notes.body);
    if (dryRun) {
      log(`[dry-run] 目标 release：${releaseUrl}`);
      log(`[dry-run] 将上传 ${uploadable.map(file => file.name).join(', ')}`);
      return;
    }

    let existing = await listAttachments(release.id);
    const conflicts = uploadable.filter(file => existing.some(asset => asset.name === file.name));

    // Gitee 附件没有 id，无法原地替换同名文件；--overwrite 只能删 release 重建
    if (conflicts.length > 0 && overwrite) {
      log(`--overwrite：删除 release ${tag} 后重建（创建时间会刷新，Gitee「最新版」可能因此改变）`);
      const removed = await gitee(`/repos/${giteeRepo}/releases/${release.id}`, { method: 'DELETE' });
      if (!removed.ok) fail(`删除旧 release 失败：HTTP ${removed.status}`);
      release = await ensureRelease(notes.body);
      existing = [];
    }

    const failed = [];
    for (const file of uploadable) {
      if (existing.some(asset => asset.name === file.name)) {
        log(`已存在 ${file.name}，跳过（需要替换请加 --overwrite）`);
        continue;
      }
      log(`上传 ${file.name}（${humanSize(file.size)}）…`);
      const ok = await uploadAttachment(release.id, file);
      if (ok) log(`✓ ${file.name}`);
      else failed.push(file.name);
    }

    const names = (await listAttachments(release.id)).map(asset => asset.name);
    log(`Gitee release 现有附件：${names.join(', ') || '（无）'}`);
    log(`发布页：${releaseUrl}`);

    const missing = uploadable.map(file => file.name).filter(name => !names.includes(name));
    if (failed.length > 0 || missing.length > 0) {
      fail(`镜像未完整：失败 ${failed.join(', ') || '无'}；缺失 ${missing.join(', ') || '无'}`);
    }
    log(`✓ 镜像完成：${uploadable.length} 个附件已在 Gitee ${tag}`);
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();

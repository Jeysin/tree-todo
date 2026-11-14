/**
 * 生成 Tauri updater 的静态清单 latest.json（docs/08 §7.3）。
 *
 * 为什么不用 tauri-action 自带的 updater JSON：本项目 macOS 出的是 universal 包，
 * 而 Tauri 只认 darwin-aarch64 / darwin-x86_64 两个平台键（没有 darwin-universal）。
 * 这里统一让两个 darwin 键指向同一个 .app.tar.gz，避免 Intel 机器静默判「无更新」。
 *
 * Linux 的更新载体是 AppImage（.deb / .rpm 无法原地替换）：清单只写一个
 * linux-x86_64 键，Tauri 2.14 会先找 linux-x86_64-{deb,rpm,appimage}，找不到再回落到它。
 *
 * 用法（CI 或本地，需已安装并登录 gh）：
 *   TAG=v2.0.0 GITHUB_REPOSITORY=Jeysin/tree-todo node scripts/updater-manifest.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.env.GITHUB_REPOSITORY || 'Jeysin/tree-todo';
const tag = process.env.TAG || process.env.GITHUB_REF_NAME;

function fail(message) {
  console.error(`[updater-manifest] ${message}`);
  process.exit(1);
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

if (!tag) fail('缺少 TAG（或 GITHUB_REF_NAME）');

const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const version = String(conf.version ?? '');
if (!/^\d+\.\d+\.\d+/.test(version)) fail(`tauri.conf.json 的 version 不合法：${version}`);

const tagVersion = tag.replace(/^v/, '');
if (tagVersion !== version) {
  fail(`tag ${tag} 与 tauri.conf.json 版本 ${version} 不一致，先改版本号再发版`);
}

const notesPath = `release-notes/${tag}.md`;
if (!existsSync(notesPath)) fail(`缺少发布说明 ${notesPath}`);
const notes = readFileSync(notesPath, 'utf8').trim();
if (!notes) fail(`${notesPath} 为空`);

const release = JSON.parse(
  gh(['release', 'view', tag, '--repo', repo, '--json', 'assets,body,publishedAt']),
);
const assets = Array.isArray(release.assets) ? release.assets : [];

const mac = assets.find(a => a.name.endsWith('.app.tar.gz'));
const win = assets.find(a => a.name.endsWith('-setup.exe'));
const linux = assets.find(a => /\.AppImage$/i.test(a.name));
if (!mac) fail('Release 中没有 macOS 更新包（*.app.tar.gz），检查 createUpdaterArtifacts / 签名密钥');
if (!win) fail('Release 中没有 Windows 安装包（*-setup.exe）');
if (!linux) fail('Release 中没有 Linux 更新包（*.AppImage），检查 Linux 构建腿 / libfuse2');

const macSigName = `${mac.name}.sig`;
const winSigName = `${win.name}.sig`;
const linuxSigName = `${linux.name}.sig`;
if (!assets.some(a => a.name === macSigName)) fail(`缺少签名文件 ${macSigName}`);
if (!assets.some(a => a.name === winSigName)) fail(`缺少签名文件 ${winSigName}`);
if (!assets.some(a => a.name === linuxSigName)) fail(`缺少签名文件 ${linuxSigName}`);

function assetUrl(name) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

const sigDir = mkdtempSync(join(tmpdir(), 'tree-todo-sig-'));
let macSignature;
let winSignature;
let linuxSignature;
try {
  // 只下载三个 .sig，避免把安装包再拉一遍。
  for (const name of [macSigName, winSigName, linuxSigName]) {
    gh(['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', sigDir, '--clobber']);
  }
  macSignature = readFileSync(join(sigDir, macSigName), 'utf8').trim();
  winSignature = readFileSync(join(sigDir, winSigName), 'utf8').trim();
  linuxSignature = readFileSync(join(sigDir, linuxSigName), 'utf8').trim();
} finally {
  rmSync(sigDir, { recursive: true, force: true });
}

if (!macSignature || !winSignature || !linuxSignature) fail('签名文件内容为空');

const manifest = {
  version,
  notes,
  pub_date: release.publishedAt || new Date().toISOString(),
  platforms: {
    'darwin-aarch64': { signature: macSignature, url: assetUrl(mac.name) },
    'darwin-x86_64': { signature: macSignature, url: assetUrl(mac.name) },
    'windows-x86_64': { signature: winSignature, url: assetUrl(win.name) },
    'linux-x86_64': { signature: linuxSignature, url: assetUrl(linux.name) },
  },
};

writeFileSync('latest.json', `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[updater-manifest] latest.json 已生成：v${version}`);
for (const [platform, entry] of Object.entries(manifest.platforms)) {
  console.log(`  ${platform} -> ${entry.url}`);
}

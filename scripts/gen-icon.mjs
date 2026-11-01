/**
 * 图标生成脚本：assets/icon.svg → assets/icon-1024.png
 * 随后运行 `pnpm tauri icon assets/icon-1024.png` 生成全套平台图标（src-tauri/icons/）。
 * 用法：node scripts/gen-icon.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(path.join(root, 'assets/icon.svg'));

await sharp(svg, { density: 300 })
  .resize(1024, 1024)
  .png()
  .toFile(path.join(root, 'assets/icon-1024.png'));

console.log('已生成 assets/icon-1024.png，接着执行：pnpm tauri icon assets/icon-1024.png');

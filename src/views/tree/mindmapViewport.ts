/**
 * 脑图视口（平移 + 缩放）的按文档隔离与持久化。
 *
 * 产品约定（视口直接影响体验，属于红线）：
 * 1. 每个文档拥有独立视口，切换文档绝不复用上一个文档的平移 / 缩放；
 * 2. 文档新建或首次打开：缩放 100%，根节点居中；
 * 3. 只有用户操作（拖拽画布、缩放、定位跳转）才会改变视口；
 * 4. 关闭文档、切到其他视图（平铺 / 统计 / 回收站）、重启应用后再次打开，恢复上次视口。
 */
import type MindElixir from 'mind-elixir';

export interface MindViewport {
  /** map 相对容器左上角的平移量（transform 的 translate3d 分量）。 */
  x: number;
  y: number;
  scale: number;
}

const STORAGE_PREFIX = 'tree-todo.viewport.';
const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
/** 新文档默认缩放：100%（不是「适应视图」）。 */
const DEFAULT_SCALE = 1;
const TRANSFORM_RE =
  /translate3d\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px,\s*0(?:px)?\)\s*scale\(\s*([\d.]+)\s*\)/;

function storageKey(docId: string): string {
  return `${STORAGE_PREFIX}${docId}`;
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return DEFAULT_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** 读取实例当前真实视口；DOM 尚未布局（没有 transform）时返回 null。 */
export function readViewport(mind: MindElixir): MindViewport | null {
  const transform = mind.map?.style.transform ?? '';
  const matched = TRANSFORM_RE.exec(transform);
  if (!matched) return null;
  const x = Number(matched[1]);
  const y = Number(matched[2]);
  const scale = Number(matched[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return null;
  return { x, y, scale: clampScale(scale) };
}

/** 读取某个文档上次保存的视口；没有记录（新文档 / 首次打开）返回 null。 */
export function loadViewport(docId: string | null): MindViewport | null {
  if (!docId) return null;
  try {
    const raw = localStorage.getItem(storageKey(docId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MindViewport> | null;
    if (!parsed) return null;
    const { x, y, scale } = parsed;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof scale !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, scale: clampScale(scale) };
  } catch {
    return null;
  }
}

/** 保存某个文档的视口（localStorage 不可用时静默降级，不影响本次会话）。 */
export function saveViewport(docId: string | null, viewport: MindViewport | null): void {
  if (!docId || !viewport) return;
  try {
    localStorage.setItem(storageKey(docId), JSON.stringify(viewport));
  } catch {
    /* 隐私模式 / 配额不足：忽略持久化失败 */
  }
}

/**
 * 应用视口。viewport 为 null 表示「新文档默认视图」：缩放 100% + 根节点居中。
 * 先走一次 toCenter：它会把 transform-origin 校正到当前文档根节点的中心
 * （不同文档根节点宽度不同，复用实例时 origin 会残留上一个文档的值），
 * 再覆盖成目标平移 / 缩放，避免缩放锚点偏移。
 */
export function applyViewport(mind: MindElixir, viewport: MindViewport | null): void {
  mind.scaleVal = viewport ? viewport.scale : DEFAULT_SCALE;
  mind.toCenter();
  if (viewport) {
    mind.map.style.transform = `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`;
  }
  mind.bus.fire('scale', mind.scaleVal);
}

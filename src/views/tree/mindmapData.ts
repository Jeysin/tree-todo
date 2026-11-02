/**
 * Zustand 快照 ↔ Mind Elixir 数据结构的纯函数适配层。
 * 数据本体始终由 Rust 提供；Mind Elixir 的 nodeData 只是当前渲染快照。
 */
import type { MindElixirData, NodeObj } from 'mind-elixir';

import type { NodeStatus, TodoNode } from '../../ipc/types';

export interface TodoMeta {
  status: NodeStatus;
  root: boolean;
}

export type TodoNodeObj = NodeObj<TodoMeta>;

export interface ParentPosition {
  parentId: string;
  position: number | null;
}

/** Mind Elixir 的 SVG 连线颜色来自属性，不能依赖 CSS 变量，因此在构建时解析成实际颜色。 */
export interface MindColors {
  accent: string;
  muted: string;
}

export const DEFAULT_MIND_COLORS: MindColors = { accent: '#4f8cff', muted: '#8b93a1' };

export function readMindColors(): MindColors {
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--accent').trim();
  const muted = style.getPropertyValue('--text-muted').trim();
  return {
    accent: accent || DEFAULT_MIND_COLORS.accent,
    muted: muted || DEFAULT_MIND_COLORS.muted,
  };
}

function toNodeObj(
  nodes: Record<string, TodoNode>,
  childrenOf: Record<string, string[]>,
  rootId: string,
  id: string,
  colors: MindColors,
  hideDone: boolean,
): TodoNodeObj {
  const node = nodes[id];
  return {
    id,
    topic: node.content,
    expanded: !node.collapsed,
    metadata: { status: node.status, root: id === rootId },
    branchColor: node.status === 'done' ? colors.muted : colors.accent,
    children: (childrenOf[id] ?? [])
      // 「隐藏已完成」：整棵 done 子树都不参与渲染（父 done ⇒ 子孙必 done）
      .filter(kid => !(hideDone && nodes[kid]?.status === 'done'))
      .map(kid => toNodeObj(nodes, childrenOf, rootId, kid, colors, hideDone)),
  };
}

/** 单根模型：取第一个根作为 Mind Elixir 的 nodeData；hideDone 时过滤已完成子树。 */
export function buildMindElixirData(
  nodes: Record<string, TodoNode>,
  roots: string[],
  childrenOf: Record<string, string[]>,
  colors: MindColors = DEFAULT_MIND_COLORS,
  hideDone = false,
): MindElixirData | null {
  const rootId = roots[0];
  if (!rootId || !nodes[rootId]) return null;
  return {
    nodeData: toNodeObj(nodes, childrenOf, rootId, rootId, colors, hideDone),
  };
}

/** 为刚创建的 Rust 节点构造 NodeObj（子节点为空，后续由 Mind Elixir 维护本地 DOM）。 */
export function nodeObjFromStore(
  nodes: Record<string, TodoNode>,
  childrenOf: Record<string, string[]>,
  rootId: string,
  id: string,
  colors: MindColors = DEFAULT_MIND_COLORS,
): TodoNodeObj | null {
  if (!nodes[id]) return null;
  // 新节点永远是 pending，不存在需要过滤的已完成子孙。
  return toNodeObj(nodes, childrenOf, rootId, id, colors, false);
}

export function statusOf(nodeObj: NodeObj | null | undefined): NodeStatus {
  const meta = (nodeObj as TodoNodeObj | null | undefined)?.metadata;
  return meta?.status ?? 'pending';
}

function metaOf(nodeObj: NodeObj): TodoMeta | undefined {
  return (nodeObj as TodoNodeObj).metadata;
}

/**
 * 结构签名：用于判断是否需要全量 refresh。
 * status 默认不参与签名（状态变化可以原地重绘，不必重建 DOM）；
 * 但开启「隐藏已完成」时，status 决定节点是否可见，必须纳入签名以触发重建。
 */
export function treeSignature(
  nodes: Record<string, TodoNode>,
  roots: string[],
  hideDone = false,
): string {
  const rootId = roots[0] ?? '';
  const parts = Object.values(nodes)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      n =>
        `${n.id}|${n.parentId ?? ''}|${n.collapsed ? 1 : 0}|${hideDone ? n.status : ''}|${n.content}`,
    );
  return `${hideDone ? 'H' : 'V'}|${rootId}\n${parts.join('\n')}`;
}

function targetSiblingPosition(
  targetId: string,
  mode: 'before' | 'after',
  nodes: Record<string, TodoNode>,
  childrenOf: Record<string, string[]>,
): ParentPosition | null {
  const target = nodes[targetId];
  if (!target || target.parentId === null) return null;
  const siblings = childrenOf[target.parentId] ?? [];
  const idx = siblings.indexOf(targetId);
  if (idx < 0) return null;
  if (mode === 'after') {
    const next = idx + 1 < siblings.length ? nodes[siblings[idx + 1]] : null;
    return {
      parentId: target.parentId,
      position: next ? (target.position + next.position) / 2 : target.position + 1024,
    };
  }
  const prev = idx > 0 ? nodes[siblings[idx - 1]] : null;
  return {
    parentId: target.parentId,
    position: prev ? (prev.position + target.position) / 2 : target.position - 1024,
  };
}

/** “成为子节点 / 插入为兄弟”对应的 Rust 父节点与 position。 */
export function dropPosition(
  targetId: string,
  mode: 'before' | 'after' | 'in',
  nodes: Record<string, TodoNode>,
  childrenOf: Record<string, string[]>,
): ParentPosition | null {
  if (mode === 'in') return { parentId: targetId, position: null };
  return targetSiblingPosition(targetId, mode, nodes, childrenOf);
}

/** 新建兄弟节点：插到目标前/后。 */
export function siblingInsertPosition(
  targetId: string,
  mode: 'before' | 'after',
  nodes: Record<string, TodoNode>,
  childrenOf: Record<string, string[]>,
): ParentPosition | null {
  return targetSiblingPosition(targetId, mode, nodes, childrenOf);
}

/** Alt+↑/↓：与相邻兄弟交换位置（分数定位）。 */
export function moveAdjacentPosition(
  id: string,
  direction: -1 | 1,
  nodes: Record<string, TodoNode>,
  childrenOf: Record<string, string[]>,
): ParentPosition | null {
  const node = nodes[id];
  if (!node || node.parentId === null) return null;
  const siblings = childrenOf[node.parentId] ?? [];
  const idx = siblings.indexOf(id);
  if (idx < 0) return null;
  if (direction === -1) {
    if (idx === 0) return null;
    const prev = nodes[siblings[idx - 1]];
    const prevPrev = idx >= 2 ? nodes[siblings[idx - 2]] : null;
    return {
      parentId: node.parentId,
      position: prevPrev ? (prevPrev.position + prev.position) / 2 : prev.position - 1024,
    };
  }
  if (idx >= siblings.length - 1) return null;
  const next = nodes[siblings[idx + 1]];
  const nextNext = idx + 2 < siblings.length ? nodes[siblings[idx + 2]] : null;
  return {
    parentId: node.parentId,
    position: nextNext ? (next.position + nextNext.position) / 2 : next.position + 1024,
  };
}

/**
 * 待办 checkbox + done 视觉。
 * 直接修改 Mind Elixir 节点 DOM，但保留 `.text` 引用，内置 inline 编辑仍然可用。
 */
export function decorateTopic(
  tpc: HTMLElement & { text?: HTMLElement },
  nodeObj: NodeObj,
  onToggle: (id: string) => void,
): void {
  const done = statusOf(nodeObj) === 'done';
  const isRoot = metaOf(nodeObj)?.root ?? !nodeObj.parent;

  let check = tpc.querySelector<HTMLButtonElement>('.todo-check');
  if (!check) {
    check = document.createElement('button');
    check.type = 'button';
    check.className = 'todo-check';
    tpc.insertBefore(check, tpc.firstChild);
  }
  check.dataset.nodeid = nodeObj.id;
  check.classList.toggle('checked', done);
  check.setAttribute('aria-checked', String(done));
  check.title = done ? '标记为待处理' : '标记为已完成';
  check.onclick = e => {
    e.preventDefault();
    e.stopPropagation();
    onToggle(nodeObj.id);
  };

  let text = tpc.querySelector<HTMLElement>('.text');
  if (!text) {
    text = document.createElement('span');
    text.className = 'text';
    tpc.appendChild(text);
  }
  tpc.text = text;
  const display = nodeObj.topic || '未命名';
  if (text.textContent !== display) text.textContent = display;

  tpc.classList.toggle('todo-done', done);
  tpc.classList.toggle('todo-root-topic', isRoot);
  tpc.classList.toggle('todo-empty', !nodeObj.topic);
}

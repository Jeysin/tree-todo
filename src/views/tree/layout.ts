/**
 * 树形（脑图）视图布局引擎（docs/03 §2.1，决策 D4）。
 * d3-hierarchy 负责垂直分布，分层偏移由本模块计算（同层左对齐、层距随该层最大宽度自适应）。
 * 多根通过不可见虚拟根合成一棵布局树。
 */
import { hierarchy, tree } from 'd3-hierarchy';

import type { TodoNode } from '../../ipc/types';
import { nodeCardWidth } from '../../lib/text';

export interface PositionedNode {
  id: string;
  /** react-flow 画布坐标（左上角）。 */
  x: number;
  y: number;
  width: number;
  node: TodoNode;
}

export interface PositionedEdge {
  id: string;
  source: string;
  target: string;
  /** target 为 done 的支线整条变灰（docs/04 §3.3）。 */
  done: boolean;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  /** 可见节点的深度优先序（↑↓ 焦点移动用）。 */
  dfsOrder: string[];
}

/** 节点卡片高度（px），与 TodoNode 组件 min-h 一致。 */
export const NODE_H = 44;
/** 同级垂直间隙（px）。 */
const GAP_Y = 16;
/** 层间距（px）。 */
const GAP_X = 56;
/** 虚拟根 id（永不渲染）。 */
const VIRTUAL_ROOT = '__virtual__';

interface LayoutItem {
  id: string;
  node: TodoNode;
  children: LayoutItem[];
}

export function computeLayout(
  nodes: Record<string, TodoNode>,
  roots: string[],
  childrenOf: Record<string, string[]>,
): LayoutResult {
  if (roots.length === 0) {
    return { nodes: [], edges: [], dfsOrder: [] };
  }

  // 1. 构建布局树：collapsed 节点剪掉 children（折叠即隐藏整棵子树）
  const buildItem = (id: string): LayoutItem => {
    const node = nodes[id];
    const kids = node.collapsed ? [] : (childrenOf[id] ?? []).map(buildItem);
    return { id, node, children: kids };
  };
  const rootItems = roots.map(buildItem);

  // 2. d3 tree 布局：nodeSize[0] 控制兄弟间距（垂直），depth 方向单位为 1
  const virtualRoot: LayoutItem = {
    id: VIRTUAL_ROOT,
    node: nodes[roots[0]]!,
    children: rootItems,
  };
  const h = hierarchy<LayoutItem>(virtualRoot, d => d.children);
  const laid = tree<LayoutItem>().nodeSize([NODE_H + GAP_Y, 1])(h);

  // 3. 分层偏移：每层 x 起点 = 前层起点 + 前层最大宽度 + GAP_X（真实层 = d3 depth - 1）
  const depthWidth: number[] = [];
  const widths = new Map<string, number>();
  laid.each(d => {
    if (d.data.id === VIRTUAL_ROOT) return;
    const w = nodeCardWidth(d.data.node.content);
    widths.set(d.data.id, w);
    depthWidth[d.depth] = Math.max(depthWidth[d.depth] ?? 0, w);
  });
  const layerX: number[] = [0];
  for (let t = 0; t + 1 < depthWidth.length; t++) {
    layerX[t + 1] = layerX[t] + (depthWidth[t] ?? 140) + GAP_X;
  }

  // 4. 输出坐标（d3.x 垂直中心 → 左上角 y；d3.y 深度 → 层起点 x）
  const outNodes: PositionedNode[] = [];
  const outEdges: PositionedEdge[] = [];
  const dfsOrder: string[] = [];
  laid.each(d => {
    if (d.data.id === VIRTUAL_ROOT) return;
    const t = d.depth - 1;
    outNodes.push({
      id: d.data.id,
      x: layerX[t] ?? 0,
      y: d.x - NODE_H / 2,
      width: widths.get(d.data.id) ?? 140,
      node: d.data.node,
    });
    dfsOrder.push(d.data.id);
    if (d.parent && d.parent.data.id !== VIRTUAL_ROOT) {
      outEdges.push({
        id: `${d.parent.data.id}->${d.data.id}`,
        source: d.parent.data.id,
        target: d.data.id,
        done: d.data.node.status === 'done',
      });
    }
  });

  return { nodes: outNodes, edges: outEdges, dfsOrder };
}

/** 统计子孙节点数（删除确认条用）。 */
export function countDescendants(
  id: string,
  childrenOf: Record<string, string[]>,
): number {
  let n = 0;
  const stack = [...(childrenOf[id] ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    n += 1;
    stack.push(...(childrenOf[cur] ?? []));
  }
  return n;
}

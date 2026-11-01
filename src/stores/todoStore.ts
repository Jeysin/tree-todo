/**
 * 全局 store（docs/01 §4 职责边界：前端只持渲染快照，每次变更后以 Rust 返回结果为准）。
 * applyAffected 是唯一的数据合并入口 —— upserted 覆盖、removed 移除，然后重建索引。
 */
import { create } from 'zustand';

import { ipc } from '../ipc';
import type { Affected, TodoNode } from '../ipc/types';

export type ViewMode = 'tree' | 'flat';

/** 平铺视图跳转定位请求（TreeView 消费后清除）。 */
export interface RevealTarget {
  id: string;
  ts: number;
}

interface TodoState {
  // ── 数据快照 ──
  nodes: Record<string, TodoNode>;
  /** 按 position 排序的根 id 列表。 */
  roots: string[];
  /** parent -> 按 position 排序的子 id 列表。 */
  childrenOf: Record<string, string[]>;
  loaded: boolean;

  // ── 视图状态 ──
  viewMode: ViewMode;
  selectedId: string | null;
  editingId: string | null;
  draft: string;
  confirmDeleteId: string | null;
  flashId: string | null;
  revealTarget: RevealTarget | null;
  /** 新建节点后的视口居中请求（保持当前缩放）。 */
  centerTarget: RevealTarget | null;

  // ── actions ──
  loadTree: () => Promise<void>;
  applyAffected: (af: Affected) => void;
  createChild: (parentId: string | null) => Promise<void>;
  createSibling: (id: string) => Promise<void>;
  toggle: (id: string) => Promise<void>;
  updateContent: (id: string, content: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setCollapsed: (id: string, collapsed: boolean) => Promise<void>;
  revealNode: (id: string) => Promise<void>;
  select: (id: string | null) => void;
  setEditing: (id: string | null) => void;
  setDraft: (d: string) => void;
  setViewMode: (m: ViewMode) => void;
  setConfirmDelete: (id: string | null) => void;
}

/** 由 nodes 重建 roots / childrenOf 索引（每次变更后全量重建，万级节点 O(n log n) 依然轻松）。 */
function rebuildIndex(nodes: Record<string, TodoNode>) {
  const roots: string[] = [];
  const childrenOf: Record<string, string[]> = {};
  for (const n of Object.values(nodes)) {
    if (n.parentId === null) {
      roots.push(n.id);
    } else {
      (childrenOf[n.parentId] ??= []).push(n.id);
    }
  }
  roots.sort((a, b) => nodes[a].position - nodes[b].position);
  for (const k of Object.keys(childrenOf)) {
    childrenOf[k].sort((a, b) => nodes[a].position - nodes[b].position);
  }
  return { roots, childrenOf };
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;

export const useTodoStore = create<TodoState>((set, get) => ({
  nodes: {},
  roots: [],
  childrenOf: {},
  loaded: false,

  viewMode: 'tree',
  selectedId: null,
  editingId: null,
  draft: '',
  confirmDeleteId: null,
  flashId: null,
  revealTarget: null,
  centerTarget: null,

  async loadTree() {
    const list = await ipc.getTree();
    const nodes: Record<string, TodoNode> = {};
    for (const n of list) nodes[n.id] = n;
    set({ nodes, ...rebuildIndex(nodes), loaded: true });
  },

  applyAffected(af) {
    const { nodes } = get();
    const next = { ...nodes };
    for (const n of af.upserted) next[n.id] = n;
    for (const id of af.removed) delete next[id];
    set({ nodes: next, ...rebuildIndex(next) });
  },

  async createChild(parentId) {
    try {
      const r = await ipc.createNode(parentId, '');
      get().applyAffected({ upserted: r.upserted, removed: [] });
      set({
        selectedId: r.newId,
        editingId: r.newId,
        draft: '',
        confirmDeleteId: null,
        centerTarget: { id: r.newId, ts: Date.now() },
      });
    } catch (e) {
      console.error('createChild failed:', e);
    }
  },

  async createSibling(id) {
    const node = get().nodes[id];
    if (!node) return;
    // 根节点上的 Enter = 新建根
    await get().createChild(node.parentId);
  },

  async toggle(id) {
    try {
      get().applyAffected(await ipc.toggleStatus(id));
    } catch (e) {
      console.error('toggle failed:', e);
    }
  },

  async updateContent(id, content) {
    try {
      get().applyAffected(await ipc.updateContent(id, content));
    } catch (e) {
      console.error('updateContent failed:', e);
    }
    // 仅当仍在本节点编辑时才退出编辑态（避免 createChild 的响应竞态清掉新节点的编辑态）
    if (get().editingId === id) set({ editingId: null });
  },

  async remove(id) {
    try {
      const { selectedId, editingId } = get();
      get().applyAffected(await ipc.deleteNode(id));
      set({
        confirmDeleteId: null,
        selectedId: selectedId === id ? null : selectedId,
        editingId: editingId === id ? null : editingId,
      });
    } catch (e) {
      console.error('remove failed:', e);
    }
  },

  async setCollapsed(id, collapsed) {
    try {
      get().applyAffected(await ipc.setCollapsed(id, collapsed));
    } catch (e) {
      console.error('setCollapsed failed:', e);
    }
  },

  async revealNode(id) {
    // 展开祖先链 → 切树形视图 → 请求视口定位
    const { nodes } = get();
    const needExpand: string[] = [];
    let cur = nodes[id]?.parentId ?? null;
    while (cur) {
      if (nodes[cur]?.collapsed) needExpand.push(cur);
      cur = nodes[cur]?.parentId ?? null;
    }
    if (needExpand.length > 0) {
      try {
        get().applyAffected(await ipc.expandNodes(needExpand));
      } catch (e) {
        console.error('expandNodes failed:', e);
      }
    }
    set({
      viewMode: 'tree',
      selectedId: id,
      flashId: id,
      revealTarget: { id, ts: Date.now() },
      editingId: null,
    });
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => set({ flashId: null }), 2400);
  },

  select(id) {
    set({ selectedId: id, confirmDeleteId: null });
  },
  setEditing(id) {
    set({ editingId: id, draft: id ? get().nodes[id]?.content ?? '' : '' });
  },
  setDraft(d) {
    set({ draft: d });
  },
  setViewMode(m) {
    set({ viewMode: m, confirmDeleteId: null });
  },
  setConfirmDelete(id) {
    set({ confirmDeleteId: id });
  },
}));

/** 平铺视图与统计用：叶子节点（无子节点的节点）。 */
export function isLeaf(state: Pick<TodoState, 'childrenOf'>, id: string): boolean {
  return (state.childrenOf[id] ?? []).length === 0;
}

/** 从叶子向上收集面包屑路径（不含自身）。 */
export function breadcrumb(state: Pick<TodoState, 'nodes'>, id: string): string[] {
  const parts: string[] = [];
  let cur = state.nodes[id]?.parentId ?? null;
  while (cur) {
    const n = state.nodes[cur];
    if (!n) break;
    parts.unshift(n.content || '(未命名)');
    cur = n.parentId;
  }
  return parts;
}

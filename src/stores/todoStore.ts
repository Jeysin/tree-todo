/**
 * 全局 store（docs/01 §4 职责边界：前端只持渲染快照，每次变更后以 Rust 返回结果为准）。
 * applyAffected 是唯一的数据合并入口 —— upserted 覆盖、removed 移除，然后重建索引。
 * v0.2：撤销/重做、拖拽移动、备注、导入导出、toast（静默删除 + 撤销）。
 * v0.3：多文档、主题切换（系统/浅色/深色）。
 * v0.4：树形视图迁移到 Mind Elixir；回收站改为文档级（节点删除物理删除）。
 */
import { create } from 'zustand';
import { confirm, open, save } from '@tauri-apps/plugin-dialog';

import { ipc } from '../ipc';
import type { Affected, AppError, DocMeta, TodoNode, TrashDoc } from '../ipc/types';

export type ViewMode = 'tree' | 'flat' | 'stats' | 'trash';
export type Theme = 'system' | 'light' | 'dark';

/** 平铺视图跳转定位请求（MindMapView 消费后清除）。 */
export interface RevealTarget {
  id: string;
  ts: number;
}

/** 底部 toast（删除后撤销等场景）。 */
export interface Toast {
  id: number;
  message: string;
  undoable: boolean;
}

/** 树形视图新建请求：TopBar 等外部入口交给 MindMapView 执行（需要先建 Rust 节点再建本地节点）。 */
export interface CreateRequest {
  parentId: string | null;
  position: number | null;
  token: number;
}

const THEME_KEY = 'tree-todo.theme';

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}

function initialTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* localStorage 不可用时回退系统 */
  }
  return 'system';
}

interface TodoState {
  // ── 数据快照 ──
  nodes: Record<string, TodoNode>;
  /** 按 position 排序的根 id 列表。 */
  roots: string[];
  /** parent -> 按 position 排序的子 id 列表。 */
  childrenOf: Record<string, string[]>;
  loaded: boolean;

  // ── 多文档（v0.3）──
  documents: DocMeta[];
  currentDocId: string | null;

  // ── 回收站（v0.4：回收文档）──
  trash: TrashDoc[];

  // ── 视图状态 ──
  viewMode: ViewMode;
  theme: Theme;
  selectedId: string | null;
  flashId: string | null;
  revealTarget: RevealTarget | null;
  /** 外部入口（TopBar）发起的新建请求，由 MindMapView 消费。 */
  createRequest: CreateRequest | null;
  /** Mind Elixir 当前缩放百分比。 */
  zoomPercent: number;
  toast: Toast | null;
  /** 搜索浮层开关（TopBar 搜索按钮 / Ctrl+F 触发）。 */
  searchOpen: boolean;

  // ── actions ──
  loadTree: () => Promise<void>;
  applyAffected: (af: Affected) => void;
  toggle: (id: string) => Promise<Affected | null>;
  collapseAll: (collapsed: boolean) => Promise<void>;
  revealNode: (id: string) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  exportData: () => Promise<void>;
  importData: () => Promise<void>;
  backupNow: () => Promise<void>;
  // 文档
  loadDocuments: () => Promise<void>;
  switchDocument: (id: string) => Promise<void>;
  createDocument: (name: string) => Promise<void>;
  renameDocument: (id: string, name: string) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  // 回收站
  loadTrash: () => Promise<void>;
  restoreTrash: (id: string) => Promise<void>;
  purgeTrash: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  // 视图
  select: (id: string | null) => void;
  setViewMode: (m: ViewMode) => void;
  setTheme: (t: Theme) => void;
  setSearchOpen: (open: boolean) => void;
  requestCreate: (parentId: string | null, position?: number | null) => void;
  clearCreateRequest: () => void;
  setZoomPercent: (percent: number) => void;
  showToast: (message: string, undoable?: boolean) => void;
  clearToast: () => void;
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

function errMsg(e: unknown, fallback: string): string {
  const ae = e as Partial<AppError> | undefined;
  if (ae && typeof ae.message === 'string' && ae.message) return ae.message;
  return fallback;
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 0;

export const useTodoStore = create<TodoState>((set, get) => ({
  nodes: {},
  roots: [],
  childrenOf: {},
  loaded: false,

  documents: [],
  currentDocId: null,

  trash: [],

  viewMode: 'tree',
  theme: initialTheme(),
  selectedId: null,
  flashId: null,
  revealTarget: null,
  createRequest: null,
  zoomPercent: 100,
  toast: null,
  searchOpen: false,

  async loadTree() {
    const list = await ipc.getTree();
    const nodes: Record<string, TodoNode> = {};
    for (const n of list) nodes[n.id] = n;
    set({ nodes, ...rebuildIndex(nodes), loaded: true });
  },

  applyAffected(af) {
    const { nodes, selectedId } = get();
    const next = { ...nodes };
    for (const n of af.upserted) next[n.id] = n;
    for (const id of af.removed) delete next[id];
    const selectedGone = selectedId !== null && !next[selectedId];
    set({
      nodes: next,
      ...rebuildIndex(next),
      ...(selectedGone ? { selectedId: null, flashId: null } : {}),
    });
  },

  async toggle(id) {
    try {
      const af = await ipc.toggleStatus(id);
      get().applyAffected(af);
      return af;
    } catch (e) {
      console.error('toggle failed:', e);
      get().showToast(errMsg(e, '状态切换失败'));
      return null;
    }
  },

  async collapseAll(collapsed) {
    try {
      get().applyAffected(await ipc.collapseAll(collapsed));
    } catch (e) {
      console.error('collapseAll failed:', e);
    }
  },

  async revealNode(id) {
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
    });
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => set({ flashId: null }), 2400);
  },

  async undo() {
    try {
      const patch = await ipc.undo();
      if (patch) {
        get().applyAffected(patch);
        get().showToast('已撤销');
      } else {
        get().showToast('没有可撤销的操作');
      }
    } catch (e) {
      console.error('undo failed:', e);
      get().showToast(errMsg(e, '撤销失败'));
    }
  },

  async redo() {
    try {
      const patch = await ipc.redo();
      if (patch) {
        get().applyAffected(patch);
        get().showToast('已重做');
      }
    } catch (e) {
      console.error('redo failed:', e);
      get().showToast(errMsg(e, '重做失败'));
    }
  },

  async exportData() {
    try {
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const path = await save({
        title: '导出 tree-todo 数据',
        defaultPath: `tree-todo-${stamp}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!path) return;
      await ipc.exportJson(path);
      get().showToast('数据已导出');
    } catch (e) {
      console.error('export failed:', e);
      get().showToast(errMsg(e, '导出失败'));
    }
  },

  async importData() {
    try {
      const path = await open({
        title: '导入 tree-todo 数据（追加到当前文档）',
        multiple: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!path || Array.isArray(path)) return;
      const af = await ipc.importJson(path);
      get().applyAffected(af);
      get().showToast(`导入完成（${af.upserted.length} 个节点，可 Ctrl+Z 撤销）`);
    } catch (e) {
      console.error('import failed:', e);
      get().showToast(errMsg(e, '导入失败'));
    }
  },

  async backupNow() {
    try {
      await ipc.backupNow();
      get().showToast('已备份当前文档（保留最近 3 份）');
    } catch (e) {
      console.error('backup failed:', e);
      get().showToast(errMsg(e, '备份失败'));
    }
  },

  // ── 多文档 ──
  async loadDocuments() {
    try {
      const idx = await ipc.listDocuments();
      set({
        documents: idx.documents,
        trash: idx.trash,
        currentDocId: idx.lastOpened ?? idx.documents[0]?.id ?? null,
      });
    } catch (e) {
      console.error('loadDocuments failed:', e);
    }
  },

  async switchDocument(id) {
    if (get().currentDocId === id) return;
    try {
      await ipc.switchDocument(id);
      set({ currentDocId: id, selectedId: null, flashId: null, viewMode: 'tree' });
      await get().loadTree();
      await get().loadDocuments();
    } catch (e) {
      console.error('switchDocument failed:', e);
      get().showToast(errMsg(e, '切换文档失败'));
    }
  },

  async createDocument(name) {
    try {
      const meta = await ipc.createDocument(name);
      await get().loadDocuments();
      await get().switchDocument(meta.id);
    } catch (e) {
      console.error('createDocument failed:', e);
      get().showToast(errMsg(e, '新建文档失败'));
    }
  },

  async renameDocument(id, name) {
    try {
      await ipc.renameDocument(id, name);
      await get().loadDocuments();
    } catch (e) {
      console.error('renameDocument failed:', e);
      get().showToast(errMsg(e, '重命名失败'));
    }
  },

  async deleteDocument(id) {
    try {
      const doc = get().documents.find(d => d.id === id);
      const ok = await confirm(
        `将文档「${doc?.name ?? id}」移入回收站？\n\n文档数据会保留，可从回收站恢复。`,
        {
          title: '删除文档',
          kind: 'warning',
          okLabel: '移入回收站',
          cancelLabel: '取消',
        },
      );
      if (!ok) return;
      const idx = await ipc.deleteDocument(id);
      set({
        documents: idx.documents,
        trash: idx.trash,
        currentDocId: idx.lastOpened ?? idx.documents[0]?.id ?? null,
        selectedId: null,
        flashId: null,
      });
      await get().loadTree();
    } catch (e) {
      console.error('deleteDocument failed:', e);
      get().showToast(errMsg(e, '删除文档失败'));
    }
  },

  // ── 回收站 ──
  async loadTrash() {
    try {
      set({ trash: await ipc.listTrash() });
    } catch (e) {
      console.error('loadTrash failed:', e);
    }
  },

  async restoreTrash(id) {
    try {
      const idx = await ipc.restoreTrash(id);
      set({ documents: idx.documents, trash: idx.trash });
      get().showToast('文档已恢复');
    } catch (e) {
      console.error('restoreTrash failed:', e);
      get().showToast(errMsg(e, '恢复失败'));
    }
  },

  async purgeTrash(id) {
    try {
      const idx = await ipc.purgeTrash(id);
      set({ documents: idx.documents, trash: idx.trash });
      get().showToast('文档已彻底删除');
    } catch (e) {
      console.error('purgeTrash failed:', e);
      get().showToast(errMsg(e, '彻底删除失败'));
    }
  },

  async emptyTrash() {
    try {
      const ok = await confirm('清空回收站？回收站内所有文档将被永久删除，不可恢复。', {
        title: '清空回收站',
        kind: 'warning',
        okLabel: '清空',
        cancelLabel: '取消',
      });
      if (!ok) return;
      const idx = await ipc.emptyTrash();
      set({ documents: idx.documents, trash: idx.trash });
      get().showToast('回收站已清空');
    } catch (e) {
      console.error('emptyTrash failed:', e);
      get().showToast(errMsg(e, '清空失败'));
    }
  },

  // ── 视图 ──
  select(id) {
    set({ selectedId: id });
  },
  setViewMode(m) {
    set({ viewMode: m, ...(m !== 'tree' ? { searchOpen: false } : {}) });
  },
  setTheme(t) {
    applyTheme(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* 忽略持久化失败 */
    }
    set({ theme: t });
  },
  setSearchOpen(open) {
    set({ searchOpen: open });
  },
  requestCreate(parentId, position = null) {
    set({ createRequest: { parentId, position, token: Date.now() } });
  },
  clearCreateRequest() {
    set({ createRequest: null });
  },
  setZoomPercent(percent) {
    set({ zoomPercent: percent });
  },
  showToast(message, undoable = false) {
    toastSeq += 1;
    set({ toast: { id: toastSeq, message, undoable } });
  },
  clearToast() {
    set({ toast: null });
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

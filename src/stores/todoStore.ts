/**
 * 全局 store（docs/01 §4 职责边界：前端只持渲染快照，每次变更后以 Rust 返回结果为准）。
 * applyAffected 是唯一的数据合并入口 —— upserted 覆盖、removed 移除，然后重建索引。
 * v0.2：撤销/重做、拖拽移动、备注、导入导出、toast（静默删除 + 撤销）。
 * v0.3：多文档、回收站（软删除）、主题切换（系统/浅色/深色）。
 */
import { create } from 'zustand';
import { confirm, open, save } from '@tauri-apps/plugin-dialog';

import { ipc } from '../ipc';
import type { Affected, AppError, DocMeta, TodoNode, TrashItem } from '../ipc/types';

export type ViewMode = 'tree' | 'flat' | 'stats' | 'trash';
export type Theme = 'system' | 'light' | 'dark';

/** 平铺视图跳转定位请求（TreeView 消费后清除）。 */
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

  // ── 回收站（v0.3）──
  trash: TrashItem[];

  // ── 视图状态 ──
  viewMode: ViewMode;
  theme: Theme;
  selectedId: string | null;
  editingId: string | null;
  draft: string;
  flashId: string | null;
  revealTarget: RevealTarget | null;
  /** 新建节点后的视口居中请求（保持当前缩放）。 */
  centerTarget: RevealTarget | null;
  /** 拖拽悬停的目标节点（高亮用）。 */
  dropTargetId: string | null;
  /** 拖拽语义：child = 成为目标子节点；sibling = 插到目标之后。 */
  dropMode: 'child' | 'sibling' | null;
  toast: Toast | null;
  /** 搜索浮层开关（TopBar 搜索按钮 / Ctrl+F 触发）。 */
  searchOpen: boolean;

  // ── actions ──
  loadTree: () => Promise<void>;
  applyAffected: (af: Affected) => void;
  createChild: (parentId: string | null) => Promise<void>;
  createSibling: (id: string) => Promise<void>;
  toggle: (id: string) => Promise<void>;
  updateContent: (id: string, content: string) => Promise<void>;
  updateNote: (id: string, note: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  moveNode: (id: string, newParentId: string | null, position?: number | null) => Promise<void>;
  setCollapsed: (id: string, collapsed: boolean) => Promise<void>;
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
  setEditing: (id: string | null) => void;
  setDraft: (d: string) => void;
  setViewMode: (m: ViewMode) => void;
  setTheme: (t: Theme) => void;
  setDropTarget: (id: string | null, mode?: 'child' | 'sibling' | null) => void;
  setSearchOpen: (open: boolean) => void;
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
  editingId: null,
  draft: '',
  flashId: null,
  revealTarget: null,
  centerTarget: null,
  dropTargetId: null,
  dropMode: null,
  toast: null,
  searchOpen: false,

  async loadTree() {
    const list = await ipc.getTree();
    const nodes: Record<string, TodoNode> = {};
    for (const n of list) nodes[n.id] = n;
    set({ nodes, ...rebuildIndex(nodes), loaded: true });
  },

  applyAffected(af) {
    const { nodes, selectedId, editingId } = get();
    const next = { ...nodes };
    for (const n of af.upserted) next[n.id] = n;
    for (const id of af.removed) delete next[id];
    const selectedGone = selectedId !== null && !next[selectedId];
    const editingGone = editingId !== null && !next[editingId];
    set({
      nodes: next,
      ...rebuildIndex(next),
      ...(selectedGone ? { selectedId: null } : {}),
      ...(editingGone ? { editingId: null, draft: '' } : {}),
    });
  },

  async createChild(parentId) {
    try {
      const r = await ipc.createNode(parentId, '');
      get().applyAffected({ upserted: r.upserted, removed: [] });
      set({
        selectedId: r.newId,
        editingId: r.newId,
        draft: '',
        centerTarget: { id: r.newId, ts: Date.now() },
      });
    } catch (e) {
      console.error('createChild failed:', e);
      get().showToast(errMsg(e, '创建节点失败'));
    }
  },

  async createSibling(id) {
    const node = get().nodes[id];
    if (!node) return;
    await get().createChild(node.parentId);
  },

  async toggle(id) {
    try {
      get().applyAffected(await ipc.toggleStatus(id));
    } catch (e) {
      console.error('toggle failed:', e);
      get().showToast(errMsg(e, '状态切换失败'));
    }
  },

  async updateContent(id, content) {
    try {
      get().applyAffected(await ipc.updateContent(id, content));
    } catch (e) {
      console.error('updateContent failed:', e);
      get().showToast(errMsg(e, '保存失败'));
    }
    if (get().editingId === id) set({ editingId: null });
  },

  async updateNote(id, note) {
    try {
      get().applyAffected(await ipc.updateNote(id, note));
    } catch (e) {
      console.error('updateNote failed:', e);
      get().showToast(errMsg(e, '备注保存失败'));
    }
  },

  /** 静默删除（软删除进入回收站）+ toast 撤销。 */
  async remove(id) {
    const node = get().nodes[id];
    try {
      const { selectedId, editingId } = get();
      get().applyAffected(await ipc.deleteNode(id));
      set({
        selectedId: selectedId === id ? null : selectedId,
        editingId: editingId === id ? null : editingId,
      });
      get().showToast(node ? `已删除「${node.content || '未命名'}」（可在回收站找回）` : '已删除', true);
      void get().loadTrash(); // 同步回收站徽标
    } catch (e) {
      console.error('remove failed:', e);
      get().showToast(errMsg(e, '删除失败'));
    }
  },

  async moveNode(id, newParentId, position = null) {
    try {
      const af = await ipc.moveNode(id, newParentId, position ?? null);
      get().applyAffected(af);
      set({ selectedId: id });
    } catch (e) {
      console.error('moveNode failed:', e);
      get().showToast(errMsg(e, '移动失败'));
    }
  },

  async setCollapsed(id, collapsed) {
    try {
      get().applyAffected(await ipc.setCollapsed(id, collapsed));
    } catch (e) {
      console.error('setCollapsed failed:', e);
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
      editingId: null,
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
      set({ currentDocId: id, selectedId: null, editingId: null, viewMode: 'tree', trash: [] });
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
      const ok = await confirm(`删除文档「${doc?.name ?? id}」？\n\n数据文件将被永久删除（含回收站内容），不影响其他文档。`, {
        title: '删除文档',
        kind: 'warning',
        okLabel: '删除',
        cancelLabel: '取消',
      });
      if (!ok) return;
      const idx = await ipc.deleteDocument(id);
      set({
        documents: idx.documents,
        currentDocId: idx.lastOpened ?? idx.documents[0]?.id ?? null,
        selectedId: null,
        editingId: null,
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
      const af = await ipc.restoreTrash(id);
      get().applyAffected(af);
      await get().loadTrash();
      get().showToast('已恢复');
    } catch (e) {
      console.error('restoreTrash failed:', e);
      get().showToast(errMsg(e, '恢复失败'));
    }
  },

  async purgeTrash(id) {
    try {
      await ipc.purgeTrash(id);
      await get().loadTrash();
      get().showToast('已彻底删除');
    } catch (e) {
      console.error('purgeTrash failed:', e);
      get().showToast(errMsg(e, '彻底删除失败'));
    }
  },

  async emptyTrash() {
    try {
      const ok = await confirm('清空回收站？所有已删除的节点将被永久移除，不可恢复。', {
        title: '清空回收站',
        kind: 'warning',
        okLabel: '清空',
        cancelLabel: '取消',
      });
      if (!ok) return;
      await ipc.emptyTrash();
      await get().loadTrash();
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
  setEditing(id) {
    set({ editingId: id, draft: id ? get().nodes[id]?.content ?? '' : '' });
  },
  setDraft(d) {
    set({ draft: d });
  },
  setViewMode(m) {
    set({ viewMode: m });
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
  setDropTarget(id, mode = null) {
    const cur = get();
    if (cur.dropTargetId !== id || cur.dropMode !== mode) {
      set({ dropTargetId: id, dropMode: mode });
    }
  },
  setSearchOpen(open) {
    set({ searchOpen: open });
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

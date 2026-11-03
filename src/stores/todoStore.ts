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
import type { Affected, AppError, DocMeta, FolderMeta, TodoNode, TrashItem } from '../ipc/types';

export type ViewMode = 'tree' | 'flat' | 'stats' | 'trash' | 'settings';
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
const HIDE_DONE_PREFIX = 'tree-todo.hideDone.';

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

/** 「隐藏已完成」按文档记忆：切换文档 / 重启后各自保持。 */
function readHideDone(docId: string | null): boolean {
  if (!docId) return false;
  try {
    return localStorage.getItem(HIDE_DONE_PREFIX + docId) === '1';
  } catch {
    return false;
  }
}

function writeHideDone(docId: string | null, value: boolean): void {
  if (!docId) return;
  try {
    localStorage.setItem(HIDE_DONE_PREFIX + docId, value ? '1' : '0');
  } catch {
    /* 忽略持久化失败 */
  }
}

/** 导出文件名里去掉路径非法字符。 */
function fileSafeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || '未命名';
}

interface TodoState {
  // ── 数据快照 ──
  nodes: Record<string, TodoNode>;
  /** 按 position 排序的根 id 列表。 */
  roots: string[];
  /** parent -> 按 position 排序的子 id 列表。 */
  childrenOf: Record<string, string[]>;
  loaded: boolean;

  // ── 多文档 / 目录（v0.3 / v0.5）──
  documents: DocMeta[];
  folders: FolderMeta[];
  currentDocId: string | null;

  // ── 回收站（v0.4：回收文档）──
  trash: TrashItem[];

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
  /** 树形视图「隐藏已完成」开关（按文档持久化）。 */
  hideDone: boolean;
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
  // 导入导出（v0.5：文档 / 目录 / 全部）
  exportDocument: (id: string, name: string) => Promise<void>;
  exportFolder: (id: string, name: string) => Promise<void>;
  exportAll: () => Promise<void>;
  importBundle: (folderId?: string | null) => Promise<void>;
  // 文档 / 目录
  loadDocuments: () => Promise<void>;
  switchDocument: (id: string) => Promise<void>;
  createDocument: (name: string, folderId?: string | null) => Promise<string | null>;
  renameDocument: (id: string, name: string) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  createFolder: (name: string, parentId: string | null) => Promise<FolderMeta | null>;
  renameFolder: (id: string, name: string) => Promise<void>;
  moveDocument: (id: string, folderId: string | null) => Promise<void>;
  moveFolder: (id: string, parentId: string | null) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
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
  setHideDone: (value: boolean) => void;
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
  folders: [],
  currentDocId: null,

  trash: [],

  viewMode: 'tree',
  theme: initialTheme(),
  selectedId: null,
  flashId: null,
  revealTarget: null,
  createRequest: null,
  zoomPercent: 100,
  hideDone: false,
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
    // 目标已完成且开着「隐藏已完成」：关掉开关再定位，否则点了也看不到。
    if (get().hideDone && nodes[id]?.status === 'done') {
      get().setHideDone(false);
      get().showToast('已关闭「隐藏已完成」以定位该节点');
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

  async exportDocument(id, name) {
    try {
      const path = await save({
        title: '导出文档',
        defaultPath: `${fileSafeName(name)}.json`,
        filters: [{ name: 'tree-todo 导出', extensions: ['json'] }],
      });
      if (!path) return;
      await ipc.exportDocument(id, path);
      get().showToast(`已导出文档「${name}」`);
    } catch (e) {
      console.error('exportDocument failed:', e);
      get().showToast(errMsg(e, '导出失败'));
    }
  },

  async exportFolder(id, name) {
    try {
      const path = await save({
        title: '导出目录（含子目录与全部文档）',
        defaultPath: `${fileSafeName(name)}-目录.json`,
        filters: [{ name: 'tree-todo 导出', extensions: ['json'] }],
      });
      if (!path) return;
      await ipc.exportFolder(id, path);
      get().showToast(`已导出目录「${name}」`);
    } catch (e) {
      console.error('exportFolder failed:', e);
      get().showToast(errMsg(e, '导出失败'));
    }
  },

  async exportAll() {
    try {
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const path = await save({
        title: '导出全部文档与目录',
        defaultPath: `tree-todo-全部-${stamp}.json`,
        filters: [{ name: 'tree-todo 导出', extensions: ['json'] }],
      });
      if (!path) return;
      await ipc.exportAll(path);
      get().showToast('已导出全部文档与目录');
    } catch (e) {
      console.error('exportAll failed:', e);
      get().showToast(errMsg(e, '导出失败'));
    }
  },

  async importBundle(folderId = null) {
    try {
      const path = await open({
        title: '导入 tree-todo 导出文件（整体还原为文档或目录）',
        multiple: false,
        filters: [{ name: 'tree-todo 导出', extensions: ['json'] }],
      });
      if (!path || Array.isArray(path)) return;
      const result = await ipc.importBundle(path, folderId);
      if (result.documentIds.length === 0 && result.folderIds.length === 0) {
        get().showToast('文件里没有可导入的内容');
        return;
      }
      await get().loadDocuments();
      if (result.firstDocumentId) {
        await get().switchDocument(result.firstDocumentId);
        get().showToast(
          result.documentIds.length > 1
            ? `已导入 ${result.documentIds.length} 个文档，已打开「${get().documents.find(d => d.id === result.firstDocumentId)?.name ?? ''}」`
            : '已导入并打开文档',
        );
      } else {
        get().showToast('已导入目录');
      }
    } catch (e) {
      console.error('importBundle failed:', e);
      get().showToast(errMsg(e, '导入失败'));
    }
  },

  // ── 多文档 ──
  async loadDocuments() {
    try {
      const idx = await ipc.listDocuments();
      const nextDoc = idx.lastOpened ?? idx.documents[0]?.id ?? null;
      set({
        documents: idx.documents,
        folders: idx.folders ?? [],
        currentDocId: nextDoc,
        hideDone: readHideDone(nextDoc),
      });
    } catch (e) {
      console.error('loadDocuments failed:', e);
    }
  },

  async switchDocument(id) {
    if (get().currentDocId === id) return;
    try {
      await ipc.switchDocument(id);
      set({
        currentDocId: id,
        selectedId: null,
        flashId: null,
        viewMode: 'tree',
        hideDone: readHideDone(id),
      });
      await get().loadTree();
      await get().loadDocuments();
    } catch (e) {
      console.error('switchDocument failed:', e);
      get().showToast(errMsg(e, '切换文档失败'));
    }
  },

  async createDocument(name, folderId = null) {
    try {
      const meta = await ipc.createDocument(name, folderId);
      await get().loadDocuments();
      await get().switchDocument(meta.id);
      return meta.id;
    } catch (e) {
      console.error('createDocument failed:', e);
      get().showToast(errMsg(e, '新建文档失败'));
      return null;
    }
  },

  async createFolder(name, parentId) {
    try {
      const meta = await ipc.createFolder(name, parentId);
      await get().loadDocuments();
      return meta;
    } catch (e) {
      console.error('createFolder failed:', e);
      get().showToast(errMsg(e, '新建目录失败'));
      return null;
    }
  },

  async renameFolder(id, name) {
    try {
      await ipc.renameFolder(id, name);
      await get().loadDocuments();
    } catch (e) {
      console.error('renameFolder failed:', e);
      get().showToast(errMsg(e, '重命名失败'));
    }
  },

  async moveDocument(id, folderId) {
    try {
      await ipc.moveDocument(id, folderId);
      await get().loadDocuments();
      get().showToast('已移动文档');
    } catch (e) {
      console.error('moveDocument failed:', e);
      get().showToast(errMsg(e, '移动失败'));
    }
  },

  async moveFolder(id, parentId) {
    try {
      await ipc.moveFolder(id, parentId);
      await get().loadDocuments();
      get().showToast('已移动目录');
    } catch (e) {
      console.error('moveFolder failed:', e);
      get().showToast(errMsg(e, '移动失败'));
    }
  },

  async deleteFolder(id) {
    try {
      const folder = get().folders.find(f => f.id === id);
      const idx = await ipc.deleteFolder(id);
      const cur = get().currentDocId;
      const next = idx.documents.some(d => d.id === cur)
        ? cur
        : (idx.lastOpened ?? idx.documents[0]?.id ?? null);
      set({
        documents: idx.documents,
        folders: idx.folders ?? [],
        currentDocId: next,
        selectedId: null,
        flashId: null,
        hideDone: readHideDone(next),
      });
      await get().loadTree();
      await get().loadTrash();
      get().showToast(`已删除目录${folder ? `「${folder.name}」` : ''}，可从回收站整体恢复`);
    } catch (e) {
      console.error('deleteFolder failed:', e);
      get().showToast(errMsg(e, '删除目录失败'));
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
      const idx = await ipc.deleteDocument(id);
      const next = idx.lastOpened ?? idx.documents[0]?.id ?? null;
      set({
        documents: idx.documents,
        folders: idx.folders ?? [],
        currentDocId: next,
        selectedId: null,
        flashId: null,
        hideDone: readHideDone(next),
      });
      await get().loadTree();
      await get().loadTrash();
    } catch (e) {
      console.error('deleteDocument failed:', e);
      get().showToast(errMsg(e, '删除文档失败'));
    }
  },

  // ── 回收站（v0.6：文档或整个目录）──
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
      set({ documents: idx.documents, folders: idx.folders ?? [] });
      await get().loadTrash();
      get().showToast('已恢复');
    } catch (e) {
      console.error('restoreTrash failed:', e);
      get().showToast(errMsg(e, '恢复失败'));
    }
  },

  async purgeTrash(id) {
    try {
      const idx = await ipc.purgeTrash(id);
      set({ documents: idx.documents, folders: idx.folders ?? [] });
      await get().loadTrash();
      get().showToast('已彻底删除');
    } catch (e) {
      console.error('purgeTrash failed:', e);
      get().showToast(errMsg(e, '彻底删除失败'));
    }
  },

  async emptyTrash() {
    try {
      const ok = await confirm('清空回收站？回收站内的文档与目录将被永久删除，不可恢复。', {
        title: '清空回收站',
        kind: 'warning',
        okLabel: '清空',
        cancelLabel: '取消',
      });
      if (!ok) return;
      const idx = await ipc.emptyTrash();
      set({ documents: idx.documents, folders: idx.folders ?? [] });
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
  setHideDone(value) {
    writeHideDone(get().currentDocId, value);
    set({ hideDone: value });
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

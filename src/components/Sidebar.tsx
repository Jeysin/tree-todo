/**
 * 左侧文档边栏（docs/05 M3 / v0.5 / v0.6）：
 * - 目录层级树：目录可嵌套，目录下可新建目录 / 文档；
 * - 拖拽调整同级顺序，或拖进 / 拖出目录；
 * - 右键菜单：新建、导出、导入、重命名、删除；空白处右键可新建；
 * - 宽度可拖拽并记忆（localStorage）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirm } from '@tauri-apps/plugin-dialog';
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  Settings,
  Trash2,
  Upload,
} from 'lucide-react';

import { AppIcon } from './AppIcon';
import { ipc } from '../ipc';
import { useTodoStore } from '../stores/todoStore';
import type { DocMeta, FolderMeta } from '../ipc/types';

const WIDTH_KEY = 'tree-todo.sidebarWidth';
const COLLAPSED_KEY = 'tree-todo.sidebarCollapsed';
const MIN_WIDTH = 180;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 218;

function readWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= MIN_WIDTH && raw <= MAX_WIDTH) return raw;
  } catch {
    /* 忽略 */
  }
  return DEFAULT_WIDTH;
}

function readCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown;
    if (Array.isArray(raw)) return new Set(raw.filter((x): x is string => typeof x === 'string'));
  } catch {
    /* 忽略 */
  }
  return new Set();
}

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略持久化失败 */
  }
}

type ItemKind = 'folder' | 'doc';

interface TreeRow {
  kind: ItemKind;
  id: string;
  name: string;
  depth: number;
  position: number;
  createdAt: string;
  folder?: FolderMeta;
  doc?: DocMeta;
}

/** 拖拽落点：行上方 / 行下方 / 拖进目录。 */
interface DropTarget {
  kind: ItemKind;
  id: string;
  zone: 'before' | 'after' | 'into';
}

type MenuState =
  | { x: number; y: number; kind: 'folder'; id: string; name: string }
  | { x: number; y: number; kind: 'doc'; id: string; name: string }
  | { x: number; y: number; kind: 'blank' };

interface Editing {
  kind: ItemKind;
  id: string;
}

/** 侧边栏选中项：目录选中决定「+」的落点，文档选中即当前打开的文档。 */
type Selection = { kind: ItemKind; id: string } | null;

const NEW_DOC_NAME = '未命名文档';
const NEW_FOLDER_NAME = '未命名目录';

/** 同级排序：先按 position，冲突（旧数据）时目录在前、再按创建时间与名称。 */
function compareSiblings(
  a: { kind: ItemKind; position: number; createdAt: string; name: string },
  b: { kind: ItemKind; position: number; createdAt: string; name: string },
): number {
  if (a.position !== b.position) return a.position - b.position;
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
  return a.name.localeCompare(b.name);
}

export function Sidebar() {
  const documents = useTodoStore(s => s.documents);
  const folders = useTodoStore(s => s.folders);
  const currentDocId = useTodoStore(s => s.currentDocId);
  const viewMode = useTodoStore(s => s.viewMode);
  const trash = useTodoStore(s => s.trash);
  const switchDocument = useTodoStore(s => s.switchDocument);
  const createDocument = useTodoStore(s => s.createDocument);
  const renameDocument = useTodoStore(s => s.renameDocument);
  const deleteDocument = useTodoStore(s => s.deleteDocument);
  const createFolder = useTodoStore(s => s.createFolder);
  const renameFolder = useTodoStore(s => s.renameFolder);
  const moveDocument = useTodoStore(s => s.moveDocument);
  const moveFolder = useTodoStore(s => s.moveFolder);
  const deleteFolder = useTodoStore(s => s.deleteFolder);
  const exportDocument = useTodoStore(s => s.exportDocument);
  const exportFolder = useTodoStore(s => s.exportFolder);
  const importBundle = useTodoStore(s => s.importBundle);
  const setViewMode = useTodoStore(s => s.setViewMode);

  const [width, setWidth] = useState(readWidth);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draftName, setDraftName] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  /** 侧边栏里当前选中的目录或文档（单击切换，互斥）。 */
  const [selection, setSelection] = useState<Selection>(null);
  const [addMenu, setAddMenu] = useState(false);
  /** 拖拽源 / 当前落点（HTML5 拖拽，用于排序与换目录）。 */
  const [drag, setDrag] = useState<{ kind: ItemKind; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [version, setVersion] = useState('');
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(width);
  const menuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  /** Esc 取消重命名时，随后的 blur 不应再提交。 */
  const cancelRenameRef = useRef(false);
  widthRef.current = width;

  /** 每个父级下目录与文档合并排序后的条目（v0.6：共享 position 坐标）。 */
  const siblingsByParent = useMemo(() => {
    type Entry = {
      kind: ItemKind;
      id: string;
      name: string;
      position: number;
      createdAt: string;
      folder?: FolderMeta;
      doc?: DocMeta;
    };
    const map = new Map<string | null, Entry[]>();
    const push = (parent: string | null, entry: Entry) => {
      (map.get(parent) ?? map.set(parent, []).get(parent)!).push(entry);
    };
    for (const f of folders) {
      push(f.parentId ?? null, {
        kind: 'folder',
        id: f.id,
        name: f.name,
        position: f.position,
        createdAt: f.createdAt,
        folder: f,
      });
    }
    for (const d of documents) {
      push(d.folderId ?? null, {
        kind: 'doc',
        id: d.id,
        name: d.name,
        position: d.position,
        createdAt: d.createdAt,
        doc: d,
      });
    }
    for (const list of map.values()) list.sort(compareSiblings);
    return map;
  }, [documents, folders]);

  const tree = useMemo<TreeRow[]>(() => {
    const rows: TreeRow[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const e of siblingsByParent.get(parentId) ?? []) {
        rows.push({
          kind: e.kind,
          id: e.id,
          name: e.name,
          depth,
          position: e.position,
          createdAt: e.createdAt,
          folder: e.folder,
          doc: e.doc,
        });
        if (e.kind === 'folder' && !collapsed.has(e.id)) walk(e.id, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  }, [siblingsByParent, collapsed]);

  /** 展平目录树（不展开/折叠、按同级排序），用于「移动到…」的目标列表。 */
  const flatFolders = useMemo(() => {
    const out: { id: string; name: string; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const e of siblingsByParent.get(parentId) ?? []) {
        if (e.kind === 'folder') {
          out.push({ id: e.id, name: e.name, depth });
          walk(e.id, depth + 1);
        }
      }
    };
    walk(null, 0);
    return out;
  }, [siblingsByParent]);

  // 左上角版本号（取自 Tauri 包版本）。
  useEffect(() => {
    void ipc
      .getAppVersion()
      .then(v => setVersion(v))
      .catch(() => {});
  }, []);

  const currentDoc = documents.find(d => d.id === currentDocId) ?? null;
  const addTargetId =
    selection?.kind === 'folder' ? selection.id : (currentDoc?.folderId ?? null);
  const addTargetName = addTargetId
    ? (folders.find(f => f.id === addTargetId)?.name ?? '根目录')
    : '根目录';

  // 当前文档变化时（切换 / 新建 / 导入），文档选中项跟着走；目录选中保持不动。
  useEffect(() => {
    if (!currentDocId) return;
    setSelection(prev =>
      prev?.kind === 'folder' ? prev : { kind: 'doc', id: currentDocId },
    );
  }, [currentDocId]);

  // 选中的目录被删掉后清空选中，避免「+」指向不存在的目录。
  useEffect(() => {
    if (selection?.kind !== 'folder') return;
    if (!folders.some(f => f.id === selection.id)) setSelection(null);
  }, [folders, selection]);

  /** 移动目标：目录不能移进自己或自己的子孙。 */
  const moveTargets = useMemo(() => {
    if (!menu || menu.kind === 'blank') return [];
    if (menu.kind !== 'folder') return flatFolders;
    const excluded = new Set<string>();
    const collect = (id: string) => {
      excluded.add(id);
      for (const f of folders) if (f.parentId === id) collect(f.id);
    };
    collect(menu.id);
    return flatFolders.filter(f => !excluded.has(f.id));
  }, [menu, folders, flatFolders]);

  const toggleFolder = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(COLLAPSED_KEY, Array.from(next));
      return next;
    });
  }, []);

  // ── 宽度拖拽 ──
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: widthRef.current };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 指针未被捕获时不影响拖拽（仍可收到 move 事件） */
    }
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const session = dragRef.current;
    if (!session) return;
    const next = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, session.startWidth + e.clientX - session.startX),
    );
    setWidth(next);
  };
  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    persist(WIDTH_KEY, widthRef.current);
  };

  // ── 右键菜单 ──
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    const close = () => setMenu(null);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  useEffect(() => {
    if (!addMenu) return;
    const onDown = (e: MouseEvent) => {
      if (addMenuRef.current?.contains(e.target as Node)) return;
      setAddMenu(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [addMenu]);

  const openMenu = (e: React.MouseEvent, row: TreeRow) => {
    e.preventDefault();
    e.stopPropagation();
    setMoveOpen(false);
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 208),
      y: Math.min(e.clientY, window.innerHeight - 232),
      kind: row.kind,
      id: row.id,
      name: row.name,
    });
  };

  const beginRename = (kind: ItemKind, id: string, name: string) => {
    setEditing({ kind, id });
    setDraftName(name);
  };

  /**
   * 新建后的命名：输入框留空并聚焦，用户直接输入即可；
   * 不输入直接失焦 / Esc 时保留后端的默认名称（未命名文档 / 未命名目录）。
   */
  const beginNewName = (kind: ItemKind, id: string) => {
    setEditing({ kind, id });
    setDraftName('');
  };

  const commitRename = () => {
    const target = editing;
    const name = draftName.trim();
    setEditing(null);
    if (!target || !name) return;
    if (target.kind === 'folder') {
      const cur = folders.find(f => f.id === target.id);
      if (cur && cur.name !== name) void renameFolder(target.id, name);
    } else {
      const cur = documents.find(d => d.id === target.id);
      if (cur && cur.name !== name) void renameDocument(target.id, name);
    }
  };

  const expandFolder = (folderId: string) => {
    setCollapsed(prev => {
      if (!prev.has(folderId)) return prev;
      const next = new Set(prev);
      next.delete(folderId);
      persist(COLLAPSED_KEY, Array.from(next));
      return next;
    });
  };

  const handleNewFolder = async (parentId: string | null) => {
    const meta = await createFolder(NEW_FOLDER_NAME, parentId);
    if (!meta) return;
    if (parentId) expandFolder(parentId);
    setSelection({ kind: 'folder', id: meta.id });
    beginNewName('folder', meta.id);
  };

  const handleNewDocument = (folderId: string | null) => {
    // 在目录里新建时确保该目录展开，否则新文档看不见。
    if (folderId) expandFolder(folderId);
    void createDocument(NEW_DOC_NAME, folderId).then(id => {
      if (!id) return;
      setSelection({ kind: 'doc', id });
      beginNewName('doc', id);
    });
  };

  /** 目录子树里待处理/文档数量，用于删除确认文案。 */
  const folderStats = (id: string): { docs: number; folders: number } => {
    const ids = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
          ids.add(f.id);
          grew = true;
        }
      }
    }
    const docs = documents.filter(d => d.folderId && ids.has(d.folderId)).length;
    return { docs, folders: ids.size - 1 };
  };

  const handleDeleteFolder = async (id: string, name: string) => {
    const stats = folderStats(id);
    const detail =
      stats.docs > 0
        ? `整个目录（含 ${stats.docs} 个文档）会移入回收站，可随时整体恢复。`
        : '目录为空，删除后可从回收站恢复。';
    const ok = await confirm(`删除目录「${name}」？\n\n${detail}`, {
      title: '删除目录',
      kind: 'warning',
      okLabel: '移入回收站',
      cancelLabel: '取消',
    });
    if (!ok) return;
    void deleteFolder(id);
  };

  const handleDeleteDoc = async (id: string, name: string) => {
    const ok = await confirm(`将文档「${name}」移入回收站？\n\n文档数据会保留，可从回收站恢复。`, {
      title: '删除文档',
      kind: 'warning',
      okLabel: '移入回收站',
      cancelLabel: '取消',
    });
    if (!ok) return;
    void deleteDocument(id);
  };

  const doMove = (targetFolderId: string | null) => {
    const target = menu;
    setMenu(null);
    setMoveOpen(false);
    if (!target || target.kind === 'blank') return;
    if (target.kind === 'folder') void moveFolder(target.id, targetFolderId);
    else void moveDocument(target.id, targetFolderId);
  };

  // ── 拖拽排序 / 换目录 ──
  const rowParentId = (row: TreeRow): string | null =>
    row.kind === 'folder' ? (row.folder?.parentId ?? null) : (row.doc?.folderId ?? null);

  /** 目录 ancestorId 是否包含 folderId（含自身）。 */
  const folderContains = useCallback(
    (ancestorId: string, folderId: string | null): boolean => {
      let cur = folderId;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        if (cur === ancestorId) return true;
        seen.add(cur);
        cur = folders.find(f => f.id === cur)?.parentId ?? null;
      }
      return false;
    },
    [folders],
  );

  const canDrop = (
    source: { kind: ItemKind; id: string },
    row: TreeRow,
    zone: 'before' | 'after' | 'into',
  ): boolean => {
    if (source.kind === row.kind && source.id === row.id) return false;
    // 文档没有子树，可以落到任意行（拖到目录中部即移入该目录）。
    if (source.kind !== 'folder') return true;
    // 目录不能拖进自己或自己的子孙（包括在子树内部做兄弟排序）。
    if (zone === 'into') return row.kind === 'folder' && !folderContains(source.id, row.id);
    if (folderContains(source.id, row.id)) return false;
    const parent = rowParentId(row);
    if (parent && folderContains(source.id, parent)) return false;
    return true;
  };

  /** 落点对应的同级位置（before/after 取相邻位置中点；into 交给后端置顶）。 */
  const dropPositionFor = (
    target: TreeRow,
    zone: 'before' | 'after' | 'into',
    source: { kind: ItemKind; id: string },
  ): number | null => {
    if (zone === 'into') return null;
    const parentId = rowParentId(target);
    const list = (siblingsByParent.get(parentId) ?? []).filter(
      e => !(e.kind === source.kind && e.id === source.id),
    );
    const idx = list.findIndex(e => e.kind === target.kind && e.id === target.id);
    if (idx < 0) return null;
    if (zone === 'before') {
      const prev = idx > 0 ? list[idx - 1] : null;
      return prev ? (prev.position + target.position) / 2 : target.position - 1024;
    }
    const next = idx + 1 < list.length ? list[idx + 1] : null;
    return next ? (target.position + next.position) / 2 : target.position + 1024;
  };

  const handleDragStart = (e: React.DragEvent, row: TreeRow) => {
    if (editing) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.id);
    setDrag({ kind: row.kind, id: row.id });
    setMenu(null);
    setAddMenu(false);
  };

  const handleDragOver = (e: React.DragEvent, row: TreeRow) => {
    if (!drag) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / Math.max(1, rect.height);
    let zone: 'before' | 'after' | 'into';
    if (row.kind === 'folder') {
      zone = ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'into';
    } else {
      zone = ratio < 0.5 ? 'before' : 'after';
    }
    if (!canDrop(drag, row, zone)) {
      setDropTarget(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(prev =>
      prev && prev.kind === row.kind && prev.id === row.id && prev.zone === zone
        ? prev
        : { kind: row.kind, id: row.id, zone },
    );
  };

  const handleDrop = (e: React.DragEvent, row: TreeRow) => {
    e.preventDefault();
    e.stopPropagation();
    const source = drag;
    const target = dropTarget;
    setDrag(null);
    setDropTarget(null);
    if (!source || !target || target.kind !== row.kind || target.id !== row.id) return;
    if (!canDrop(source, row, target.zone)) return;
    if (target.zone === 'into') expandFolder(row.id);
    const parentId = target.zone === 'into' ? row.id : rowParentId(row);
    const position = dropPositionFor(row, target.zone, source);
    if (source.kind === 'folder') void moveFolder(source.id, parentId, position);
    else void moveDocument(source.id, parentId, position);
  };

  const menuItemClass =
    'w-full flex items-center gap-2 px-3 h-8 text-[13px] text-primary hover:bg-base transition-colors';

  return (
    <aside
      style={{ width }}
      className="relative shrink-0 flex flex-col bg-surface border-r border-border"
    >
      <div className="relative flex items-center gap-2 px-3.5 h-12 border-b border-border shrink-0">
        <AppIcon size={22} />
        <span className="text-[15px] font-semibold tracking-tight text-primary select-none">
          Tree Todo
        </span>
        {version && (
          <span
            className="text-[11px] text-muted/80 tabular-nums select-none"
            title={`Tree Todo v${version}`}
          >
            v{version}
          </span>
        )}
      </div>

      <div
        className="flex-1 overflow-y-auto py-2.5 px-2"
        onClick={e => {
          const el = e.target as HTMLElement;
          if (el.closest('[data-sidebar-row]') || el.closest('[data-sidebar-action]')) return;
          setSelection(null);
        }}
        onContextMenu={e => {
          const el = e.target as HTMLElement;
          if (el.closest('[data-sidebar-row]') || el.closest('[data-sidebar-action]')) return;
          e.preventDefault();
          setAddMenu(false);
          setMoveOpen(false);
          setMenu({
            x: Math.min(e.clientX, window.innerWidth - 208),
            y: Math.min(e.clientY, window.innerHeight - 132),
            kind: 'blank',
          });
        }}
      >
        <div ref={addMenuRef} className="relative flex items-center justify-between px-2 pb-1.5">
          <span className="text-[11px] font-medium text-muted uppercase tracking-wider select-none">
            文档
          </span>
          <button
            data-sidebar-action
            onClick={() => setAddMenu(v => !v)}
            className="w-5 h-5 rounded flex items-center justify-center text-muted hover:text-primary hover:bg-base transition-colors"
            title="新建"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          {addMenu && (
            <div
              data-sidebar-action
              className="absolute right-0 top-6 z-50 w-44 rounded-lg border border-border bg-elevated shadow-xl py-1"
            >
              <div className="px-3 pt-1 pb-1.5 text-[11px] text-muted select-none truncate">
                在「{addTargetName}」下新建
              </div>
              <button
                onClick={() => {
                  setAddMenu(false);
                  handleNewDocument(addTargetId);
                }}
                className={menuItemClass}
              >
                <FileText className="w-3.5 h-3.5 text-muted" />
                新建文档
              </button>
              <button
                onClick={() => {
                  setAddMenu(false);
                  void handleNewFolder(addTargetId);
                }}
                className={menuItemClass}
              >
                <FolderPlus className="w-3.5 h-3.5 text-muted" />
                新建目录
              </button>
            </div>
          )}
        </div>

        {tree.map(row => {
          const isEditing = editing?.kind === row.kind && editing.id === row.id;
          const isFolder = row.kind === 'folder';
          const selected = selection?.kind === row.kind && selection.id === row.id;
          const open = isFolder && !collapsed.has(row.id);
          const isDragSource = drag?.kind === row.kind && drag.id === row.id;
          const dropZone =
            dropTarget?.kind === row.kind && dropTarget.id === row.id ? dropTarget.zone : null;
          return (
            <div
              key={`${row.kind}-${row.id}`}
              data-sidebar-row
              draggable={!isEditing}
              onDragStart={e => handleDragStart(e, row)}
              onDragEnd={() => {
                setDrag(null);
                setDropTarget(null);
              }}
              onDragOver={e => handleDragOver(e, row)}
              onDragLeave={e => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setDropTarget(prev =>
                  prev && prev.kind === row.kind && prev.id === row.id ? null : prev,
                );
              }}
              onDrop={e => handleDrop(e, row)}
              onClick={() => {
                if (isEditing) return;
                if (isFolder) {
                  // 单击目录 = 选中（「+」的新建落点）；展开/折叠走左侧箭头
                  setSelection({ kind: 'folder', id: row.id });
                  return;
                }
                // 单击文档 = 选中并打开，同时清掉目录选中
                setSelection({ kind: 'doc', id: row.id });
                if (row.id !== currentDocId) void switchDocument(row.id);
                else if (viewMode !== 'tree') setViewMode('tree');
              }}
              onDoubleClick={() => {
                if (!isEditing) beginRename(row.kind, row.id, row.name);
              }}
              onContextMenu={e => openMenu(e, row)}
              style={{ paddingLeft: 8 + row.depth * 12 }}
              className={[
                'group relative flex items-center gap-1.5 pr-2 h-7 rounded-md cursor-pointer text-[13px] transition-colors',
                selected
                  ? 'bg-accent/12 text-primary font-medium'
                  : 'text-muted hover:bg-base hover:text-primary',
                isDragSource ? 'opacity-40' : '',
                dropZone === 'into' ? 'bg-accent/15 text-primary ring-1 ring-accent/40' : '',
              ].join(' ')}
              title={isFolder ? row.name : selected ? `${row.name}（双击重命名）` : row.name}
            >
              {isFolder ? (
                <>
                  <span
                    onClick={e => {
                      e.stopPropagation();
                      toggleFolder(row.id);
                    }}
                    className="w-4 h-4 flex items-center justify-center rounded hover:bg-base shrink-0"
                    title={open ? '折叠目录' : '展开目录'}
                  >
                    {open ? (
                      <ChevronDown className="w-3 h-3 text-muted/80" />
                    ) : (
                      <ChevronRight className="w-3 h-3 text-muted/80" />
                    )}
                  </span>
                  {open ? (
                    <FolderOpen
                      className={[
                        'w-3.5 h-3.5 shrink-0',
                        selected ? 'text-accent' : 'text-muted',
                      ].join(' ')}
                    />
                  ) : (
                    <Folder
                      className={[
                        'w-3.5 h-3.5 shrink-0',
                        selected ? 'text-accent' : 'text-muted',
                      ].join(' ')}
                    />
                  )}
                </>
              ) : (
                <>
                  {/* 与目录的箭头占位对齐，保证同级目录/文档图标垂直对齐 */}
                  <span className="w-4 h-4 shrink-0" />
                  <FileText
                    className={['w-3.5 h-3.5 shrink-0', selected ? 'text-accent' : ''].join(' ')}
                  />
                </>
              )}

              {isEditing ? (
                <input
                  autoFocus
                  value={draftName}
                  placeholder={isFolder ? NEW_FOLDER_NAME : NEW_DOC_NAME}
                  onChange={e => setDraftName(e.target.value)}
                  onFocus={e => e.currentTarget.select()}
                  onBlur={() => {
                    if (cancelRenameRef.current) {
                      cancelRenameRef.current = false;
                      return;
                    }
                    commitRename();
                  }}
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => {
                    e.stopPropagation();
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') {
                      cancelRenameRef.current = true;
                      setEditing(null);
                    }
                  }}
                  className="flex-1 min-w-0 bg-transparent outline-none text-primary border-b border-accent/60 placeholder:text-muted/50"
                />
              ) : (
                <span className="flex-1 truncate">{row.name}</span>
              )}

              {!isEditing && !isFolder && documents.length > 1 && (
                <button
                  onClick={e => {
                    e.stopPropagation();
                    void handleDeleteDoc(row.id, row.name);
                  }}
                  className="opacity-0 group-hover:opacity-100 w-5 h-5 rounded flex items-center justify-center text-muted hover:text-red-500 transition-all"
                  title="删除文档"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}

              {dropZone === 'before' && (
                <span className="pointer-events-none absolute left-2 right-2 -top-[2px] h-0.5 rounded-full bg-accent" />
              )}
              {dropZone === 'after' && (
                <span className="pointer-events-none absolute left-2 right-2 -bottom-[2px] h-0.5 rounded-full bg-accent" />
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-border px-2 py-1 shrink-0 flex items-center justify-between">
        <button
          onClick={() => setViewMode('trash')}
          className={[
            'relative w-7 h-7 rounded-md flex items-center justify-center transition-colors',
            viewMode === 'trash' ? 'bg-accent/12 text-accent' : 'text-muted hover:bg-base hover:text-primary',
          ].join(' ')}
          title="回收站"
          aria-label="回收站"
        >
          <Trash2 className="w-4 h-4" />
          {trash.length > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full bg-accent text-white text-[9px] leading-3.5 text-center">
              {trash.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setViewMode('settings')}
          className={[
            'w-7 h-7 rounded-md flex items-center justify-center transition-colors',
            viewMode === 'settings' ? 'bg-accent/12 text-accent' : 'text-muted hover:bg-base hover:text-primary',
          ].join(' ')}
          title="设置（Ctrl+,）"
          aria-label="设置"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

      {/* 宽度拖拽手柄 */}
      <div
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
        title="拖拽调整侧边栏宽度"
      />

      {menu && (
        <div
          ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-50 w-48 rounded-lg border border-border bg-elevated shadow-xl py-1"
          onContextMenu={e => e.preventDefault()}
        >
          {menu.kind === 'blank' ? (
            <>
              <button
                onClick={() => {
                  setMenu(null);
                  handleNewDocument(null);
                }}
                className={menuItemClass}
              >
                <FileText className="w-3.5 h-3.5 text-muted" />
                新建文档
              </button>
              <button
                onClick={() => {
                  setMenu(null);
                  void handleNewFolder(null);
                }}
                className={menuItemClass}
              >
                <FolderPlus className="w-3.5 h-3.5 text-muted" />
                新建目录
              </button>
            </>
          ) : menu.kind === 'folder' ? (
            <>
              <button
                onClick={() => {
                  const id = menu.id;
                  setMenu(null);
                  handleNewDocument(id);
                }}
                className={menuItemClass}
              >
                <FileText className="w-3.5 h-3.5 text-muted" />
                新建文档
              </button>
              <button
                onClick={() => {
                  const id = menu.id;
                  setMenu(null);
                  void handleNewFolder(id);
                }}
                className={menuItemClass}
              >
                <FolderPlus className="w-3.5 h-3.5 text-muted" />
                新建子目录
              </button>
              <div className="my-1 border-t border-border" />
              <button
                onClick={() => {
                  const { id, name } = menu;
                  setMenu(null);
                  void exportFolder(id, name);
                }}
                className={menuItemClass}
              >
                <Download className="w-3.5 h-3.5 text-muted" />
                导出
              </button>
              <button
                onClick={() => {
                  const id = menu.id;
                  setMenu(null);
                  void importBundle(id);
                }}
                className={menuItemClass}
              >
                <Upload className="w-3.5 h-3.5 text-muted" />
                导入到此目录…
              </button>
              <div
                className="relative"
                onMouseEnter={() => setMoveOpen(true)}
                onMouseLeave={() => setMoveOpen(false)}
              >
                <button onClick={() => setMoveOpen(v => !v)} className={menuItemClass}>
                  <FolderInput className="w-3.5 h-3.5 text-muted" />
                  移动到…
                  <ChevronRight className="w-3 h-3 ml-auto text-muted" />
                </button>
                {moveOpen && (
                  <div className="absolute left-full top-0 ml-1 w-52 max-h-64 overflow-y-auto rounded-lg border border-border bg-elevated shadow-xl py-1">
                    <button onClick={() => doMove(null)} className={menuItemClass}>
                      <Folder className="w-3.5 h-3.5 text-muted" />
                      根目录
                    </button>
                    {moveTargets.map(f => (
                      <button
                        key={f.id}
                        onClick={() => doMove(f.id)}
                        style={{ paddingLeft: 12 + f.depth * 12 }}
                        className="w-full flex items-center gap-2 pr-3 h-8 text-[13px] text-primary hover:bg-base transition-colors"
                      >
                        <Folder className="w-3 h-3 text-muted shrink-0" />
                        <span className="truncate">{f.name}</span>
                      </button>
                    ))}
                    {moveTargets.length === 0 && (
                      <div className="px-3 py-2 text-[12px] text-muted">没有可选目录</div>
                    )}
                  </div>
                )}
              </div>
              <div className="my-1 border-t border-border" />
              <button
                onClick={() => {
                  const { id, name } = menu;
                  setMenu(null);
                  beginRename('folder', id, name);
                }}
                className={menuItemClass}
              >
                <Pencil className="w-3.5 h-3.5 text-muted" />
                重命名
              </button>
              <button
                onClick={() => {
                  const { id, name } = menu;
                  setMenu(null);
                  void handleDeleteFolder(id, name);
                }}
                className={menuItemClass}
              >
                <Trash2 className="w-3.5 h-3.5 text-muted" />
                删除目录
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  const { id, name } = menu;
                  setMenu(null);
                  void exportDocument(id, name);
                }}
                className={menuItemClass}
              >
                <Download className="w-3.5 h-3.5 text-muted" />
                导出
              </button>
              <div
                className="relative"
                onMouseEnter={() => setMoveOpen(true)}
                onMouseLeave={() => setMoveOpen(false)}
              >
                <button onClick={() => setMoveOpen(v => !v)} className={menuItemClass}>
                  <FolderInput className="w-3.5 h-3.5 text-muted" />
                  移动到…
                  <ChevronRight className="w-3 h-3 ml-auto text-muted" />
                </button>
                {moveOpen && (
                  <div className="absolute left-full top-0 ml-1 w-52 max-h-64 overflow-y-auto rounded-lg border border-border bg-elevated shadow-xl py-1">
                    <button onClick={() => doMove(null)} className={menuItemClass}>
                      <Folder className="w-3.5 h-3.5 text-muted" />
                      根目录
                    </button>
                    {moveTargets.map(f => (
                      <button
                        key={f.id}
                        onClick={() => doMove(f.id)}
                        style={{ paddingLeft: 12 + f.depth * 12 }}
                        className="w-full flex items-center gap-2 pr-3 h-8 text-[13px] text-primary hover:bg-base transition-colors"
                      >
                        <Folder className="w-3 h-3 text-muted shrink-0" />
                        <span className="truncate">{f.name}</span>
                      </button>
                    ))}
                    {moveTargets.length === 0 && (
                      <div className="px-3 py-2 text-[12px] text-muted">没有可选目录</div>
                    )}
                  </div>
                )}
              </div>
              <div className="my-1 border-t border-border" />
              <button
                onClick={() => {
                  const { id, name } = menu;
                  setMenu(null);
                  beginRename('doc', id, name);
                }}
                className={menuItemClass}
              >
                <Pencil className="w-3.5 h-3.5 text-muted" />
                重命名
              </button>
              <button
                onClick={() => {
                  const { id, name } = menu;
                  setMenu(null);
                  void handleDeleteDoc(id, name);
                }}
                className={menuItemClass}
              >
                <Trash2 className="w-3.5 h-3.5 text-muted" />
                删除文档
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * 左侧文档边栏（docs/05 M3 / v0.5）：
 * - 目录层级树：目录可嵌套，目录下可新建目录 / 文档；
 * - 右键菜单：新建、导出、导入、重命名、删除；
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

interface TreeRow {
  kind: 'folder' | 'doc';
  id: string;
  name: string;
  depth: number;
  folder?: FolderMeta;
  doc?: DocMeta;
}

interface MenuState {
  x: number;
  y: number;
  kind: 'folder' | 'doc';
  id: string;
  name: string;
}

interface Editing {
  kind: 'folder' | 'doc';
  id: string;
}

/** 侧边栏选中项：目录选中决定「+」的落点，文档选中即当前打开的文档。 */
type Selection = { kind: 'folder' | 'doc'; id: string } | null;

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
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(width);
  const menuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  /** Esc 取消重命名时，随后的 blur 不应再提交。 */
  const cancelRenameRef = useRef(false);
  widthRef.current = width;

  const tree = useMemo<TreeRow[]>(() => {
    const foldersByParent = new Map<string | null, FolderMeta[]>();
    for (const f of folders) {
      const key = f.parentId ?? null;
      (foldersByParent.get(key) ?? foldersByParent.set(key, []).get(key)!).push(f);
    }
    const docsByFolder = new Map<string | null, DocMeta[]>();
    for (const d of documents) {
      const key = d.folderId ?? null;
      (docsByFolder.get(key) ?? docsByFolder.set(key, []).get(key)!).push(d);
    }
    const rows: TreeRow[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const f of foldersByParent.get(parentId) ?? []) {
        rows.push({ kind: 'folder', id: f.id, name: f.name, depth, folder: f });
        if (!collapsed.has(f.id)) walk(f.id, depth + 1);
      }
      for (const d of docsByFolder.get(parentId) ?? []) {
        rows.push({ kind: 'doc', id: d.id, name: d.name, depth, doc: d });
      }
    };
    walk(null, 0);
    return rows;
  }, [documents, folders, collapsed]);

  /** 展平目录树（不展开/折叠），用于「移动到…」的目标列表。 */
  const flatFolders = useMemo(() => {
    const out: { id: string; name: string; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const f of folders) {
        if ((f.parentId ?? null) === parentId) {
          out.push({ id: f.id, name: f.name, depth });
          walk(f.id, depth + 1);
        }
      }
    };
    walk(null, 0);
    return out;
  }, [folders]);

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
    if (!menu) return [];
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
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.startWidth + e.clientX - drag.startX));
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

  const beginRename = (kind: 'folder' | 'doc', id: string, name: string) => {
    setEditing({ kind, id });
    setDraftName(name);
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

  const handleNewFolder = async (parentId: string | null) => {
    const meta = await createFolder('新目录', parentId);
    if (!meta) return;
    if (parentId) {
      setCollapsed(prev => {
        const next = new Set(prev);
        next.delete(parentId);
        persist(COLLAPSED_KEY, Array.from(next));
        return next;
      });
    }
    setSelection({ kind: 'folder', id: meta.id });
    beginRename('folder', meta.id, meta.name);
  };

  const handleNewDocument = (folderId: string | null) => {
    if (folderId) {
      // 在目录里新建时确保该目录展开，否则新文档看不见。
      setCollapsed(prev => {
        if (!prev.has(folderId)) return prev;
        const next = new Set(prev);
        next.delete(folderId);
        persist(COLLAPSED_KEY, Array.from(next));
        return next;
      });
    }
    void createDocument('新文档', folderId).then(id => {
      if (id) setSelection({ kind: 'doc', id });
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
    if (!target) return;
    if (target.kind === 'folder') void moveFolder(target.id, targetFolderId);
    else void moveDocument(target.id, targetFolderId);
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
          tree-todo
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-2.5 px-2">
        <div ref={addMenuRef} className="relative flex items-center justify-between px-2 pb-1.5">
          <span className="text-[11px] font-medium text-muted uppercase tracking-wider select-none">
            文档
          </span>
          <button
            onClick={() => setAddMenu(v => !v)}
            className="w-5 h-5 rounded flex items-center justify-center text-muted hover:text-primary hover:bg-base transition-colors"
            title="新建"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          {addMenu && (
            <div className="absolute right-0 top-6 z-50 w-44 rounded-lg border border-border bg-elevated shadow-xl py-1">
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
          return (
            <div
              key={`${row.kind}-${row.id}`}
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
                'group flex items-center gap-1.5 pr-2 h-7 rounded-md cursor-pointer text-[13px] transition-colors',
                selected
                  ? 'bg-accent/12 text-primary font-medium'
                  : 'text-muted hover:bg-base hover:text-primary',
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
                  className="flex-1 min-w-0 bg-transparent outline-none text-primary border-b border-accent/60"
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
          {menu.kind === 'folder' ? (
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

/**
 * 文档选择器（docs/10 §7.1）：仿访达的浮层面板，代替原生 <select>。
 *
 * 为什么不用 <select>：① 文档一多就是一条几百项的长列表；② macOS 会把
 * <optgroup> 的标签渲染成不可点的「假选项」，看起来像重复的文档；
 * ③ 没法搜索。面板形态可以同时解决这三点。
 *
 * 通用组件：只吃 documents / folders / value / onChange，不读任何 store，
 * 所以「顶栏切换文档」「移动文档到…」等场景可直接复用。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Layers,
  Search,
  X,
} from 'lucide-react';

import type { DocMeta, FolderMeta } from '../ipc/types';
import {
  buildDocTree,
  buildFolderPathMap,
  flattenDocTree,
  folderChainOf,
  type DocTreeNode,
} from '../lib/docTree';

const PANEL_WIDTH = 320;
/**
 * 面板期望高度：既用于「向上还是向下展开」的判断，也作为首帧的测量上限。
 * 取 440 而不是「内容刚好放下」：11 行（4 个目录 + 6 个文档 + 全部文档）约 380px，
 * 若上限贴着这个值，一个亚像素的余量就会触发那条几乎满高的滚动条，看着很脏。
 */
const PANEL_HEIGHT = 440;
const VIEWPORT_GAP = 8;
const ROW_INDENT = 14;

export interface DocPickerProps {
  documents: DocMeta[];
  folders: FolderMeta[];
  /** 选中的文档 id；null = 全部文档（`includeAll` 为 true 时才有这一项）。 */
  value: string | null;
  onChange: (docId: string | null) => void;
  /** 是否提供「全部文档」这一项（默认 true）。 */
  includeAll?: boolean;
  allLabel?: string;
  /** 未选中文档且没有「全部文档」项时的占位文案。 */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

interface Row {
  key: string;
  kind: 'all' | 'folder' | 'doc';
  id: string;
  name: string;
  depth: number;
  /** 搜索结果里的所属路径（树模式为空）。 */
  path?: string;
  count?: number;
  expanded?: boolean;
  doc?: DocMeta;
}

export function DocPicker({
  documents,
  folders,
  value,
  onChange,
  includeAll = true,
  allLabel = '全部文档',
  placeholder = '选择文档',
  disabled = false,
  className = '',
  ariaLabel = '选择文档',
}: DocPickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const tree = useMemo(() => buildDocTree(documents, folders), [documents, folders]);
  const pathMap = useMemo(() => buildFolderPathMap(folders), [folders]);
  const docsInOrder = useMemo(() => flattenDocTree(tree), [tree]);
  const currentDoc = value ? documents.find(d => d.id === value) : undefined;
  const currentPath = currentDoc?.folderId ? (pathMap.get(currentDoc.folderId) ?? '') : '';

  const rows = useMemo<Row[]>(() => {
    const keyword = query.trim().toLowerCase();
    if (keyword) {
      return docsInOrder
        .filter(d => d.name.toLowerCase().includes(keyword))
        .map(d => ({
          key: `d:${d.id}`,
          kind: 'doc' as const,
          id: d.id,
          name: d.name,
          depth: 0,
          path: d.folderId ? (pathMap.get(d.folderId) ?? '') : '',
          doc: d,
        }));
    }

    const out: Row[] = [];
    if (includeAll) {
      out.push({ key: 'all', kind: 'all', id: '', name: allLabel, depth: 0, count: documents.length });
    }
    const walk = (nodes: DocTreeNode[], depth: number) => {
      for (const node of nodes) {
        if (node.kind === 'doc') {
          out.push({ key: `d:${node.id}`, kind: 'doc', id: node.id, name: node.name, depth, doc: node.doc });
          continue;
        }
        const isOpen = expanded.has(node.id);
        out.push({
          key: `f:${node.id}`,
          kind: 'folder',
          id: node.id,
          name: node.name,
          depth,
          count: node.documentCount,
          expanded: isOpen,
        });
        if (isOpen) walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  }, [query, docsInOrder, pathMap, includeAll, allLabel, documents.length, expanded, tree]);

  // 行数变化（搜索 / 折叠）后把高亮行夹回有效范围。
  useEffect(() => {
    setActive(prev => (rows.length === 0 ? 0 : Math.min(prev, rows.length - 1)));
  }, [rows.length]);

  // 高亮行始终留在可视区（键盘导航时手不会离开键盘）。
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const close = useCallback(() => {
    setOpen(false);
    setPos(null);
  }, []);

  const openPanel = () => {
    if (disabled) return;
    // 打开时展开「当前选中文档」的祖先目录，保证选中项一眼可见；其余保持折叠，
    // 这样文档再多也不会一次铺满整个面板（找不到就用搜索）。
    setExpanded(new Set(folderChainOf(currentDoc?.folderId ?? null, folders)));
    setQuery('');
    setActive(0);
    setOpen(true);
  };

  const toggleFolder = useCallback((id: string, force?: boolean) => {
    setExpanded(prev => {
      const next = new Set(prev);
      const shouldOpen = force ?? !next.has(id);
      if (shouldOpen) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const pick = useCallback(
    (row: Row) => {
      if (row.kind === 'folder') {
        toggleFolder(row.id);
        return;
      }
      onChange(row.kind === 'all' ? null : row.id);
      close();
      triggerRef.current?.focus();
    },
    [close, onChange, toggleFolder],
  );

  // 定位：与触发按钮右对齐、贴下方；下方放不下就翻到上方。
  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const height = panel.offsetHeight || PANEL_HEIGHT;
      const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_GAP * 2;
      const spaceAbove = rect.top - VIEWPORT_GAP * 2;
      const up = height > spaceBelow && spaceAbove > spaceBelow;
      const maxHeight = Math.max(220, Math.min(PANEL_HEIGHT, up ? spaceAbove : spaceBelow));
      const left = Math.min(
        Math.max(VIEWPORT_GAP, rect.right - PANEL_WIDTH),
        window.innerWidth - PANEL_WIDTH - VIEWPORT_GAP,
      );
      const top = up
        ? Math.max(VIEWPORT_GAP, rect.top - Math.min(height, maxHeight) - 6)
        : rect.bottom + 6;
      setPos({ left, top, maxHeight });
    };

    place();
    // 首次测量时面板还带着上限制，内容换行后高度会变，下一帧再校一次；
    // 顺带在这里聚焦搜索框（此时面板已经 visible，否则 focus 会被忽略）。
    const raf = requestAnimationFrame(() => {
      place();
      inputRef.current?.focus({ preventScroll: true });
    });
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // 点击面板外关闭；Esc 用 window 级监听，这样焦点被 Tab 移出面板后依然能关。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
      triggerRef.current?.focus();
    };
    const onBlur = () => close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, close]);

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActive(prev => (prev + delta + rows.length) % rows.length);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : Math.max(0, rows.length - 1));
      return;
    }
    if (e.key === 'Enter') {
      const row = rows[active];
      if (row) {
        e.preventDefault();
        pick(row);
      }
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const row = rows[active];
      if (row?.kind !== 'folder') return;
      e.preventDefault();
      toggleFolder(row.id, e.key === 'ArrowRight');
    }
  };

  const label = currentDoc?.name ?? (includeAll ? allLabel : placeholder);
  const triggerTitle = currentDoc
    ? `统计范围：${currentPath ? `${currentPath} / ` : ''}${currentDoc.name}`
    : label;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : openPanel())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={triggerTitle}
        className={[
          'inline-flex h-8 min-w-[112px] max-w-[200px] items-center gap-1.5 rounded-md border border-border bg-surface pl-2 pr-1.5',
          'text-[12px] text-primary transition-colors hover:bg-base disabled:cursor-not-allowed disabled:opacity-50',
          open ? 'border-accent/60' : '',
          className,
        ].join(' ')}
      >
        {currentDoc ? (
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted" />
        ) : (
          <Layers className="h-3.5 w-3.5 shrink-0 text-muted" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={ariaLabel}
            onKeyDown={onPanelKeyDown}
            style={{
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              width: PANEL_WIDTH,
              maxHeight: pos?.maxHeight ?? PANEL_HEIGHT,
              visibility: pos ? 'visible' : 'hidden',
            }}
            className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl"
          >
            <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                placeholder="搜索文档…"
                aria-label="搜索文档"
                className="h-5 min-w-0 flex-1 bg-transparent text-[12px] text-primary outline-none placeholder:text-muted/70"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setActive(0);
                    inputRef.current?.focus();
                  }}
                  aria-label="清空搜索"
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted hover:bg-base hover:text-primary"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            <div
              ref={listRef}
              role="listbox"
              aria-label="文档列表"
              className="min-h-0 flex-1 overflow-y-auto py-1"
            >
              {rows.length === 0 && (
                <div className="px-3 py-6 text-center text-[11.5px] text-muted">没有匹配的文档</div>
              )}
              {rows.map((row, index) => {
                const selected = row.kind === 'all' ? value === null && includeAll : row.id === value;
                const isActive = index === active;
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-idx={index}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pick(row)}
                    style={{ paddingLeft: VIEWPORT_GAP + 2 + row.depth * ROW_INDENT }}
                    className={[
                      'flex w-full items-center gap-1.5 pr-2 text-left text-[12px] transition-colors',
                      row.path ? 'py-1' : 'h-7',
                      isActive ? 'bg-base' : '',
                      selected ? 'text-primary' : 'text-primary/90',
                    ].join(' ')}
                  >
                    {row.kind === 'folder' ? (
                      <>
                        <ChevronRight
                          className={`h-3 w-3 shrink-0 text-muted transition-transform ${
                            row.expanded ? 'rotate-90' : ''
                          }`}
                        />
                        {row.expanded ? (
                          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted" />
                        ) : (
                          <Folder className="h-3.5 w-3.5 shrink-0 text-muted" />
                        )}
                      </>
                    ) : row.kind === 'all' ? (
                      <Layers className="h-3.5 w-3.5 shrink-0 text-muted" />
                    ) : (
                      <FileText className="ml-[18px] h-3.5 w-3.5 shrink-0 text-muted" />
                    )}

                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{row.name}</span>
                      {row.path && <span className="block truncate text-[10.5px] text-muted/80">{row.path}</span>}
                    </span>

                    {row.kind === 'folder' && (row.count ?? 0) > 0 && (
                      <span className="shrink-0 text-[10.5px] tabular-nums text-muted/70">{row.count}</span>
                    )}
                    {row.kind === 'all' && (row.count ?? 0) > 0 && (
                      <span className="shrink-0 text-[10.5px] tabular-nums text-muted/70">{row.count}</span>
                    )}
                    {selected && row.kind !== 'folder' && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                    )}
                  </button>
                );
              })}
            </div>

            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-2.5 py-1.5 text-[10.5px] text-muted/80">
              <span className="tabular-nums">
                {query ? `${rows.length} 个匹配` : `${documents.length} 个文档`}
              </span>
              <span className="tabular-nums">↑↓ 选择 · ↵ 确认 · Esc 关闭</span>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

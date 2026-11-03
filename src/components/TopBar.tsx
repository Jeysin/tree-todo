import { useEffect, useRef, useState } from 'react';
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  Eye,
  EyeOff,
  Keyboard,
  MoreHorizontal,
  Search,
} from 'lucide-react';

import { useTodoStore } from '../stores/todoStore';
import { useRunStore } from '../stores/runStore';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** 常用快捷键（docs/04 §5）。macOS 用 ⌘ / ⇧ 展示。 */
const SHORTCUT_GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: '新建与编辑',
    items: [
      { keys: ['N'], label: '在根任务下新建' },
      { keys: ['Tab'], label: '新建子任务' },
      { keys: ['Enter'], label: '新建同级任务' },
      { keys: ['F2'], label: '编辑节点' },
      { keys: ['Esc'], label: '取消编辑 / 关闭搜索' },
    ],
  },
  {
    title: '状态',
    items: [
      { keys: ['S'], label: '完成 / 取消完成' },
      { keys: ['Delete'], label: '删除节点' },
      { keys: [IS_MAC ? '⌘' : 'Ctrl', 'Z'], label: '撤销' },
      { keys: [IS_MAC ? '⌘' : 'Ctrl', '⇧', 'Z'], label: '重做' },
    ],
  },
  {
    title: '视图',
    items: [
      { keys: [IS_MAC ? '⌘' : 'Ctrl', '1'], label: '树形视图' },
      { keys: [IS_MAC ? '⌘' : 'Ctrl', '2'], label: '平铺视图' },
      { keys: [IS_MAC ? '⌘' : 'Ctrl', '3'], label: '统计视图' },
      { keys: [IS_MAC ? '⌘' : 'Ctrl', 'F'], label: '搜索' },
      { keys: ['⇧', '1'], label: '适应视图' },
      { keys: ['Space', '拖拽'], label: '平移画布' },
      { keys: [IS_MAC ? '⌘' : 'Ctrl', '. / ,'], label: '折叠 / 展开' },
    ],
  },
];

/** 顶栏（docs/04 §2）：视图切换 + 文件菜单 + 更多菜单 + 快捷键教程。 */
export function TopBar() {
  const viewMode = useTodoStore(s => s.viewMode);
  const setViewMode = useTodoStore(s => s.setViewMode);
  const documents = useTodoStore(s => s.documents);
  const currentDocId = useTodoStore(s => s.currentDocId);
  const exportDocument = useTodoStore(s => s.exportDocument);
  const collapseAll = useTodoStore(s => s.collapseAll);
  const setSearchOpen = useTodoStore(s => s.setSearchOpen);
  const hideDone = useTodoStore(s => s.hideDone);
  const setHideDone = useTodoStore(s => s.setHideDone);
  const runs = useRunStore(s => s.runs);

  // 运行 / 待验收计数（从 runs 派生，不额外轮询）。
  const runningCount = runs.filter(r => r.status === 'running' || r.status === 'queued').length;
  const awaitingCount = runs.filter(r => r.status === 'awaiting_review').length;
  const latestRunId =
    runs.find(r => r.status === 'awaiting_review' || r.status === 'running' || r.status === 'queued')
      ?.id ?? null;

  const [moreOpen, setMoreOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const helpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current?.contains(e.target as Node)) return;
      setMoreOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [moreOpen]);

  useEffect(() => () => {
    if (helpTimer.current) clearTimeout(helpTimer.current);
  }, []);

  const openHelp = () => {
    if (helpTimer.current) clearTimeout(helpTimer.current);
    setHelpOpen(true);
  };
  const scheduleCloseHelp = () => {
    if (helpTimer.current) clearTimeout(helpTimer.current);
    helpTimer.current = setTimeout(() => setHelpOpen(false), 120);
  };

  const currentDoc = documents.find(d => d.id === currentDocId) ?? null;

  const tab = (active: boolean) =>
    [
      'px-3 h-6 rounded-md text-[13px] leading-6 transition-all duration-150',
      active ? 'bg-surface text-primary shadow-sm font-medium' : 'text-muted hover:text-primary',
    ].join(' ');

  const iconBtn =
    'w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-primary hover:bg-base transition-colors';

  const menuItem =
    'w-full flex items-center gap-2 px-3 h-8 text-[13px] text-primary hover:bg-base transition-colors';

  return (
    <header className="relative z-30 flex items-center gap-3 h-12 px-4 border-b border-border bg-surface shrink-0">
      <nav className="flex items-center gap-0.5 p-0.5 rounded-lg bg-base border border-border">
        <button className={tab(viewMode === 'tree')} onClick={() => setViewMode('tree')} title="树形视图 (Ctrl+1)">
          树形
        </button>
        <button className={tab(viewMode === 'flat')} onClick={() => setViewMode('flat')} title="平铺视图 (Ctrl+2)">
          平铺
        </button>
        <button className={tab(viewMode === 'stats')} onClick={() => setViewMode('stats')} title="统计视图 (Ctrl+3)">
          统计
        </button>
      </nav>

      <div className="flex-1" />

      {/* 待验收 / 运行中 徽标（docs/06 §9.5）：全局可见，点击打开运行抽屉 */}
      {(runningCount > 0 || awaitingCount > 0) && (
        <button
          onClick={() => useRunStore.getState().openRun(latestRunId)}
          title={awaitingCount > 0 ? `${awaitingCount} 个任务待验收` : `${runningCount} 个任务执行中`}
          className="h-7 px-2.5 rounded-md border border-border text-xs text-muted hover:text-primary hover:bg-base inline-flex items-center gap-1.5"
        >
          {runningCount > 0 && (
            <span className="inline-flex items-center gap-1 text-accent">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              {runningCount}
            </span>
          )}
          {awaitingCount > 0 && (
            <span className="inline-flex items-center gap-1 text-warning">
              <span className="w-1.5 h-1.5 rounded-full bg-warning" />
              待验收 {awaitingCount}
            </span>
          )}
        </button>
      )}

      {viewMode === 'tree' && (
        <>
          <button className={iconBtn} onClick={() => setSearchOpen(true)} title="搜索 (Ctrl+F)">
            <Search className="w-4 h-4" />
          </button>
          <button className={iconBtn} onClick={() => void collapseAll(true)} title="折叠全部">
            <ChevronsDownUp className="w-4 h-4" />
          </button>
          <button className={iconBtn} onClick={() => void collapseAll(false)} title="展开全部">
            <ChevronsUpDown className="w-4 h-4" />
          </button>
          <button
            onClick={() => setHideDone(!hideDone)}
            aria-pressed={hideDone}
            title="隐藏已完成节点"
            className={[
              'w-8 h-8 rounded-lg flex items-center justify-center transition-colors',
              hideDone
                ? 'text-accent bg-accent/12'
                : 'text-muted hover:text-primary hover:bg-base',
            ].join(' ')}
          >
            {hideDone ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </>
      )}

      {/* 全局导出 / 导入在系统菜单栏的 File 菜单里（见 src-tauri/src/lib.rs） */}
      <div className="relative" ref={moreRef}>
        <button
          className={iconBtn}
          onClick={() => setMoreOpen(v => !v)}
          title="更多"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
        {moreOpen && (
          <div className="absolute right-0 top-9 z-40 w-52 rounded-lg border border-border bg-elevated shadow-xl py-1">
            <button
              onClick={() => {
                setMoreOpen(false);
                if (currentDoc) void exportDocument(currentDoc.id, currentDoc.name);
              }}
              disabled={!currentDoc}
              className={menuItem + ' disabled:opacity-40'}
            >
              <Download className="w-3.5 h-3.5 text-muted" />
              导出
            </button>
          </div>
        )}
      </div>

      {viewMode === 'tree' && (
        <button
          onMouseEnter={openHelp}
          onMouseLeave={scheduleCloseHelp}
          onFocus={openHelp}
          onBlur={scheduleCloseHelp}
          className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-border text-[13px] text-muted hover:text-primary hover:bg-base transition-colors"
          title="常用快捷键"
          aria-label="常用快捷键"
        >
          <Keyboard className="w-4 h-4" />
          快捷键
        </button>
      )}

      {viewMode === 'tree' && helpOpen && (
        <div
          onMouseEnter={openHelp}
          onMouseLeave={scheduleCloseHelp}
          className="absolute right-4 top-[52px] z-40 w-[272px] max-h-[calc(100vh-72px)] overflow-y-auto rounded-xl border border-border/70 bg-elevated/85 backdrop-blur-xl shadow-2xl p-3"
        >
          <div className="px-1 pb-1 text-[11px] font-medium text-muted uppercase tracking-wider select-none">
            常用快捷键
          </div>
          {SHORTCUT_GROUPS.map(group => (
            <section key={group.title} className="pt-2">
              <h3 className="px-1 pb-1 text-[11px] text-muted/80 select-none">{group.title}</h3>
              {group.items.map(item => (
                <div
                  key={item.label}
                  className="flex items-center justify-between gap-3 h-7 px-1 text-[12px] text-primary"
                >
                  <span className="truncate">{item.label}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {item.keys.map(k => (
                      <kbd
                        key={k}
                        className="inline-flex items-center justify-center h-5 min-w-5 px-1 rounded border border-border bg-base text-[11px] font-medium text-muted"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </header>
  );
}

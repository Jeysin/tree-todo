import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  Monitor,
  Moon,
  MoreHorizontal,
  Plus,
  Save,
  Search,
  Sun,
  Upload,
} from 'lucide-react';

import { useTodoStore, type Theme } from '../stores/todoStore';

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
];

/** 顶栏（docs/04 §2）：视图切换 + 树形工具栏 + 更多菜单（导入导出 / 备份 / 主题）。 */
export function TopBar() {
  const viewMode = useTodoStore(s => s.viewMode);
  const setViewMode = useTodoStore(s => s.setViewMode);
  const createChild = useTodoStore(s => s.createChild);
  const loaded = useTodoStore(s => s.loaded);
  const collapseAll = useTodoStore(s => s.collapseAll);
  const setSearchOpen = useTodoStore(s => s.setSearchOpen);
  const exportData = useTodoStore(s => s.exportData);
  const importData = useTodoStore(s => s.importData);
  const backupNow = useTodoStore(s => s.backupNow);
  const theme = useTodoStore(s => s.theme);
  const setTheme = useTodoStore(s => s.setTheme);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

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
    <header className="flex items-center gap-4 h-12 px-4 border-b border-border bg-surface shrink-0">
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
        </>
      )}

      <div className="relative" ref={menuRef}>
        <button className={iconBtn} onClick={() => setMenuOpen(v => !v)} title="更多">
          <MoreHorizontal className="w-4 h-4" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-9 z-40 w-48 rounded-lg border border-border bg-elevated shadow-xl py-1">
            <div className="px-3 pt-1 pb-1.5 text-[11px] text-muted select-none">主题</div>
            {THEME_OPTIONS.map(opt => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.value}
                  onClick={() => {
                    setTheme(opt.value);
                  }}
                  className={menuItem}
                >
                  <Icon className="w-3.5 h-3.5 text-muted" />
                  {opt.label}
                  {theme === opt.value && <Check className="w-3.5 h-3.5 ml-auto text-accent" />}
                </button>
              );
            })}
            <div className="my-1 border-t border-border" />
            <button
              onClick={() => {
                setMenuOpen(false);
                void exportData();
              }}
              className={menuItem}
            >
              <Download className="w-3.5 h-3.5 text-muted" />
              导出数据（JSON）
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                void importData();
              }}
              className={menuItem}
            >
              <Upload className="w-3.5 h-3.5 text-muted" />
              导入数据（追加）
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                void backupNow();
              }}
              className={menuItem}
            >
              <Save className="w-3.5 h-3.5 text-muted" />
              立即备份
            </button>
          </div>
        )}
      </div>

      {(viewMode === 'tree' || viewMode === 'flat') && (
        <button
          onClick={() => void createChild(null)}
          disabled={!loaded}
          className="flex items-center gap-1.5 px-3 h-8 rounded-lg bg-accent text-white text-[13px] font-medium shadow-sm hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-40"
          title="新建根节点"
        >
          <Plus className="w-4 h-4" />
          新建根节点
        </button>
      )}
    </header>
  );
}

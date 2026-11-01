import { useEffect, useRef, useState } from 'react';
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  MoreHorizontal,
  Plus,
  Search,
  Upload,
} from 'lucide-react';

import { AppIcon } from './AppIcon';
import { useTodoStore } from '../stores/todoStore';

/** 顶栏（docs/04 §2）：品牌 + 视图切换 + 搜索 / 折叠全部 / 导入导出 + 新建根。 */
export function TopBar() {
  const viewMode = useTodoStore(s => s.viewMode);
  const setViewMode = useTodoStore(s => s.setViewMode);
  const createChild = useTodoStore(s => s.createChild);
  const loaded = useTodoStore(s => s.loaded);
  const collapseAll = useTodoStore(s => s.collapseAll);
  const setSearchOpen = useTodoStore(s => s.setSearchOpen);
  const exportData = useTodoStore(s => s.exportData);
  const importData = useTodoStore(s => s.importData);

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

  return (
    <header className="flex items-center gap-4 h-12 px-4 border-b border-border bg-surface shrink-0">
      <span className="flex items-center gap-2 select-none">
        <AppIcon size={22} />
        <span className="text-[15px] font-semibold tracking-tight text-primary">tree-todo</span>
      </span>

      <nav className="flex items-center gap-0.5 p-0.5 rounded-lg bg-base border border-border">
        <button className={tab(viewMode === 'tree')} onClick={() => setViewMode('tree')} title="树形视图 (Ctrl+1)">
          树形
        </button>
        <button className={tab(viewMode === 'flat')} onClick={() => setViewMode('flat')} title="平铺视图 (Ctrl+2)">
          平铺
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
          <div className="absolute right-0 top-9 z-40 w-44 rounded-lg border border-border bg-elevated shadow-xl py-1">
            <button
              onClick={() => {
                setMenuOpen(false);
                void exportData();
              }}
              className="w-full flex items-center gap-2 px-3 h-8 text-[13px] text-primary hover:bg-base transition-colors"
            >
              <Download className="w-3.5 h-3.5 text-muted" />
              导出数据（JSON）
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                void importData();
              }}
              className="w-full flex items-center gap-2 px-3 h-8 text-[13px] text-primary hover:bg-base transition-colors"
            >
              <Upload className="w-3.5 h-3.5 text-muted" />
              导入数据（追加）
            </button>
          </div>
        )}
      </div>

      <button
        onClick={() => void createChild(null)}
        disabled={!loaded}
        className="flex items-center gap-1.5 px-3 h-8 rounded-lg bg-accent text-white text-[13px] font-medium shadow-sm hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-40"
      >
        <Plus className="w-4 h-4" />
        新建根节点
      </button>
    </header>
  );
}

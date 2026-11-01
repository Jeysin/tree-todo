import { Plus } from 'lucide-react';

import { AppIcon } from './AppIcon';
import { useTodoStore } from '../stores/todoStore';

/** 顶栏（docs/04 §2）：标识 + 视图切换 + 新建根。 */
export function TopBar() {
  const viewMode = useTodoStore(s => s.viewMode);
  const setViewMode = useTodoStore(s => s.setViewMode);
  const createChild = useTodoStore(s => s.createChild);
  const loaded = useTodoStore(s => s.loaded);

  const tab = (active: boolean) =>
    [
      'px-3 h-6 rounded-md text-[13px] leading-6 transition-all duration-150',
      active
        ? 'bg-surface text-primary shadow-sm font-medium'
        : 'text-muted hover:text-primary',
    ].join(' ');

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

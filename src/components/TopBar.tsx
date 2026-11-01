import { Plus } from 'lucide-react';

import { useTodoStore } from '../stores/todoStore';

/** 顶栏（docs/04 §2）：标识 + 视图切换 + 新建根。 */
export function TopBar() {
  const viewMode = useTodoStore(s => s.viewMode);
  const setViewMode = useTodoStore(s => s.setViewMode);
  const createChild = useTodoStore(s => s.createChild);
  const loaded = useTodoStore(s => s.loaded);

  const tab = (active: boolean) =>
    [
      'px-3 h-7 text-sm transition-colors',
      active ? 'bg-accent text-white' : 'text-muted hover:text-primary hover:bg-base',
    ].join(' ');

  return (
    <header className="flex items-center gap-3 h-11 px-3 border-b border-border bg-surface shrink-0">
      <span className="flex items-center gap-1.5 text-sm font-semibold text-primary select-none">
        <span className="w-2 h-2 rotate-45 rounded-[2px] bg-accent" />
        tree-todo
      </span>

      <nav className="flex items-center rounded-lg border border-border overflow-hidden ml-1">
        <button className={tab(viewMode === 'tree')} onClick={() => setViewMode('tree')} title="Ctrl+1">
          树形
        </button>
        <button className={tab(viewMode === 'flat')} onClick={() => setViewMode('flat')} title="Ctrl+2">
          平铺
        </button>
      </nav>

      <div className="flex-1" />

      <button
        onClick={() => void createChild(null)}
        disabled={!loaded}
        className="flex items-center gap-1 px-3 h-7 rounded-lg bg-accent text-white text-sm hover:opacity-90 transition-opacity disabled:opacity-40"
      >
        <Plus className="w-4 h-4" />
        新建根节点
      </button>
    </header>
  );
}

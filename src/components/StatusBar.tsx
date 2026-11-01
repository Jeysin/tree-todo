import { useMemo } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import { useReactFlow, useStore } from '@xyflow/react';

import { useTodoStore } from '../stores/todoStore';

/** 缩放控制（仅树形视图；docs/04 §2 状态栏右侧）。 */
function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useStore(s => s.transform[2]);

  const btn =
    'w-6 h-6 rounded flex items-center justify-center hover:bg-base hover:text-primary transition-colors';

  return (
    <div className="flex items-center gap-1">
      <button className={btn} onClick={() => void zoomOut({ duration: 150 })} title="缩小">
        <Minus className="w-3.5 h-3.5" />
      </button>
      <span className="w-11 text-center tabular-nums select-none">{Math.round(zoom * 100)}%</span>
      <button className={btn} onClick={() => void zoomIn({ duration: 150 })} title="放大">
        <Plus className="w-3.5 h-3.5" />
      </button>
      <button className={btn} onClick={() => void fitView({ padding: 0.15, duration: 300 })} title="适应视图 (Shift+1)">
        <Maximize className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/** 状态栏（docs/04 §2）：叶子统计 + 完成率 + 缩放控制。 */
export function StatusBar() {
  const nodes = useTodoStore(s => s.nodes);
  const childrenOf = useTodoStore(s => s.childrenOf);
  const viewMode = useTodoStore(s => s.viewMode);

  const stats = useMemo(() => {
    let pending = 0;
    let done = 0;
    for (const n of Object.values(nodes)) {
      if ((childrenOf[n.id] ?? []).length === 0) {
        if (n.status === 'pending') pending += 1;
        else done += 1;
      }
    }
    const total = pending + done;
    return { pending, done, rate: total === 0 ? 0 : Math.round((done / total) * 100) };
  }, [nodes, childrenOf]);

  return (
    <footer className="flex items-center justify-between h-9 px-4 border-t border-border bg-surface text-xs text-muted shrink-0">
      <span className="select-none flex items-center gap-1.5">
        <b className="font-semibold text-primary tabular-nums">{stats.pending}</b> 待处理
        <span className="text-border">·</span>
        <b className="font-semibold text-primary tabular-nums">{stats.done}</b> 已完成
        <span className="text-border">·</span>
        叶子完成率 <b className="font-semibold text-primary tabular-nums">{stats.rate}%</b>
      </span>
      {viewMode === 'tree' && <ZoomControls />}
    </footer>
  );
}

import { useMemo } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';

import { useOverviewStore } from '../stores/overviewStore';
import { useTodoStore } from '../stores/todoStore';
import { mindMapFit, mindMapZoomIn, mindMapZoomOut } from '../views/tree/mindmapApi';

/** 缩放控制（仅树形视图；docs/04 §2 状态栏右侧）。 */
function ZoomControls() {
  const zoom = useTodoStore(s => s.zoomPercent);

  const btn =
    'w-6 h-6 rounded flex items-center justify-center hover:bg-base hover:text-primary transition-colors';

  return (
    <div className="flex items-center gap-1">
      <button className={btn} onClick={mindMapZoomOut} title="缩小">
        <Minus className="w-3.5 h-3.5" />
      </button>
      <span className="w-11 text-center tabular-nums select-none">{zoom}%</span>
      <button className={btn} onClick={mindMapZoomIn} title="放大">
        <Plus className="w-3.5 h-3.5" />
      </button>
      <button className={btn} onClick={mindMapFit} title="适应视图 (Shift+1)">
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
  const overview = useOverviewStore(s => s.response);

  const stats = useMemo(() => {
    let pending = 0;
    let done = 0;
    let running = 0;
    let awaiting = 0;
    for (const n of Object.values(nodes)) {
      const exec = n.execution?.state;
      if (exec === 'running' || exec === 'queued') running += 1;
      if (exec === 'awaiting_review') awaiting += 1;
      if ((childrenOf[n.id] ?? []).length === 0) {
        if (n.status === 'pending') pending += 1;
        else done += 1;
      }
    }
    const total = pending + done;
    return { pending, done, running, awaiting, rate: total === 0 ? 0 : Math.round((done / total) * 100) };
  }, [nodes, childrenOf]);

  // 全局层：显示全局摘要，避免把文档级数字带进总览造成新的语义错乱。
  if (viewMode === 'overview') {
    const synced = overview?.syncedDocs ?? 0;
    const skipped = overview?.skippedDocs ?? 0;
    return (
      <footer className="flex items-center justify-between h-9 px-4 border-t border-border bg-surface text-xs text-muted shrink-0">
        <span className="select-none flex items-center gap-1.5">
          总览
          <span className="text-border">·</span>
          <b className="font-semibold text-primary tabular-nums">{synced}</b> 个文档
          <span className="text-border">·</span>
          {overview?.stale ? '正在同步…' : '已同步'}
          {skipped > 0 && (
            <>
              <span className="text-border">·</span>
              <span className="text-warning">{skipped} 个文档暂时无法读取</span>
            </>
          )}
        </span>
        <span className="select-none">不含回收站 · 按本地 00:00 分日</span>
      </footer>
    );
  }

  return (
    <footer className="flex items-center justify-between h-9 px-4 border-t border-border bg-surface text-xs text-muted shrink-0">
      <span className="select-none flex items-center gap-1.5">
        <b className="font-semibold text-primary tabular-nums">{stats.pending}</b> 待处理
        <span className="text-border">·</span>
        <b className="font-semibold text-primary tabular-nums">{stats.done}</b> 已完成
        <span className="text-border">·</span>
        叶子完成率 <b className="font-semibold text-primary tabular-nums">{stats.rate}%</b>
        {stats.running > 0 && (
          <>
            <span className="text-border">·</span>
            <span className="text-accent">AI 执行中 {stats.running}</span>
          </>
        )}
        {stats.awaiting > 0 && (
          <>
            <span className="text-border">·</span>
            <span className="text-warning">待验收 {stats.awaiting}</span>
          </>
        )}
      </span>
      {viewMode === 'tree' && <ZoomControls />}
    </footer>
  );
}

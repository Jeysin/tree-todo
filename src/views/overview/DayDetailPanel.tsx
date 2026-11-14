/**
 * 当日完成明细（docs/10 §7.6）：默认今天，点格子切换日期。
 * 点条目 → 切到该文档 → 在树里定位并高亮节点。
 */
import { CheckCircle2, Loader2 } from 'lucide-react';

import { formatDateCN } from '../../lib/heatmap';
import { useOverviewStore } from '../../stores/overviewStore';
import { useTodoStore } from '../../stores/todoStore';

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function DayDetailPanel() {
  const selectedDate = useOverviewStore(s => s.selectedDate);
  const detail = useOverviewStore(s => s.detail);
  const loading = useOverviewStore(s => s.detailLoading);
  const switchDocument = useTodoStore(s => s.switchDocument);
  const revealNode = useTodoStore(s => s.revealNode);

  const open = async (docId: string, nodeId: string) => {
    await switchDocument(docId);
    await revealNode(nodeId);
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <header className="flex items-baseline justify-between gap-2 pb-3 border-b border-border/70">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-primary truncate">
            {selectedDate ? formatDateCN(selectedDate) : '选择一天'}
          </h2>
          <p className="mt-0.5 text-[11px] text-muted">
            {loading ? '读取中…' : `完成 ${detail.length} 个叶子任务`}
          </p>
        </div>
        {loading && <Loader2 className="w-3.5 h-3.5 text-muted animate-spin shrink-0" />}
      </header>

      <div className="pt-2">
        {loading && detail.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-muted">读取中…</div>
        ) : detail.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-[12px] text-muted">这天没有完成记录</p>
            <p className="mt-1 text-[11px] text-muted/70">勾选一个叶子任务，这里就会亮起来</p>
          </div>
        ) : (
          <ul className="-mx-1 max-h-[360px] overflow-y-auto">
            {detail.map(item => (
              <li key={`${item.docId}-${item.nodeId}`}>
                <button
                  type="button"
                  onClick={() => void open(item.docId, item.nodeId)}
                  title={`在「${item.docName}」中定位`}
                  className="group w-full flex items-start gap-2 px-1 py-2 rounded-md text-left hover:bg-base transition-colors"
                >
                  <span className="mt-[3px] shrink-0">
                    <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="text-[11px] tabular-nums text-muted shrink-0">
                        {timeOf(item.completedAt)}
                      </span>
                      <span className="text-[12.5px] text-primary leading-5 line-clamp-2">
                        {item.content}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[10.5px] text-muted/80 truncate">
                      {item.docName}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-3 pt-3 border-t border-border/70 text-[10.5px] leading-4 text-muted/80">
        只统计当前仍存在的叶子任务；删除任务或把文档移入回收站，对应数字会减少。
      </p>
    </section>
  );
}

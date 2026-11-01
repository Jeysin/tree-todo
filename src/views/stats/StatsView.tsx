/** 统计视图（docs/05 M3）：按任务线统计完成率与最近 7 天完成数。 */
import { useMemo } from 'react';
import { CheckCircle2, ListTodo, TrendingUp } from 'lucide-react';

import { useTodoStore } from '../../stores/todoStore';

interface RootStats {
  id: string;
  name: string;
  pending: number;
  done: number;
  total: number;
  weekDone: number;
  rate: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function StatsView() {
  const nodes = useTodoStore(s => s.nodes);
  const roots = useTodoStore(s => s.roots);
  const childrenOf = useTodoStore(s => s.childrenOf);

  const perRoot = useMemo<RootStats[]>(() => {
    const weekAgo = Date.now() - WEEK_MS;
    const results: RootStats[] = roots.map(rid => {
      let pending = 0;
      let done = 0;
      let weekDone = 0;
      const walk = (id: string) => {
        const kids = childrenOf[id] ?? [];
        if (kids.length === 0) {
          const n = nodes[id];
          if (!n) return;
          if (n.status === 'pending') {
            pending += 1;
          } else {
            done += 1;
            if (n.completedAt && Date.parse(n.completedAt) >= weekAgo) weekDone += 1;
          }
          return;
        }
        for (const k of kids) walk(k);
      };
      walk(rid);
      const total = pending + done;
      return {
        id: rid,
        name: nodes[rid]?.content || '未命名任务线',
        pending,
        done,
        total,
        weekDone,
        rate: total === 0 ? 0 : Math.round((done / total) * 100),
      };
    });
    return results.sort((a, b) => b.total - a.total);
  }, [nodes, roots, childrenOf]);

  const overall = useMemo(() => {
    const pending = perRoot.reduce((s, r) => s + r.pending, 0);
    const done = perRoot.reduce((s, r) => s + r.done, 0);
    const weekDone = perRoot.reduce((s, r) => s + r.weekDone, 0);
    const total = pending + done;
    return { pending, done, weekDone, total, rate: total === 0 ? 0 : Math.round((done / total) * 100) };
  }, [perRoot]);

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="max-w-3xl mx-auto py-6 px-4">
        <h1 className="text-lg font-semibold text-primary mb-1">统计</h1>
        <p className="text-xs text-muted mb-5">按任务线查看叶子完成进度与最近 7 天完成量</p>

        {/* 总览 */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center gap-1.5 text-xs text-muted mb-2">
              <ListTodo className="w-3.5 h-3.5" />
              叶子总数
            </div>
            <div className="text-2xl font-semibold text-primary tabular-nums">{overall.total}</div>
            <div className="text-xs text-muted mt-1">
              {overall.pending} 待处理 · {overall.done} 已完成
            </div>
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center gap-1.5 text-xs text-muted mb-2">
              <CheckCircle2 className="w-3.5 h-3.5" />
              完成率
            </div>
            <div className="text-2xl font-semibold text-primary tabular-nums">{overall.rate}%</div>
            <div className="h-1.5 mt-2 rounded-full bg-base overflow-hidden">
              <div
                className="h-full rounded-full bg-success transition-all duration-500"
                style={{ width: `${overall.rate}%` }}
              />
            </div>
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center gap-1.5 text-xs text-muted mb-2">
              <TrendingUp className="w-3.5 h-3.5" />
              最近 7 天完成
            </div>
            <div className="text-2xl font-semibold text-primary tabular-nums">{overall.weekDone}</div>
            <div className="text-xs text-muted mt-1">叶子节点</div>
          </div>
        </div>

        {/* 每条任务线 */}
        {perRoot.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted">还没有任务线，去树里创建第一个任务吧</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {perRoot.map(r => (
              <div key={r.id} className="rounded-xl border border-border bg-surface px-4 py-3">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <span className="text-sm font-medium text-primary truncate">{r.name}</span>
                  <span className="text-xs text-muted tabular-nums shrink-0">
                    {r.done}/{r.total} · {r.rate}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-base overflow-hidden">
                  <div
                    className={[
                      'h-full rounded-full transition-all duration-500',
                      r.rate === 100 ? 'bg-success' : 'bg-accent',
                    ].join(' ')}
                    style={{ width: `${r.rate}%` }}
                  />
                </div>
                <div className="flex items-center gap-3 mt-2 text-xs text-muted tabular-nums">
                  <span>{r.pending} 待处理</span>
                  <span className="text-border">·</span>
                  <span>{r.done} 已完成</span>
                  {r.weekDone > 0 && (
                    <>
                      <span className="text-border">·</span>
                      <span className="text-success">本周 +{r.weekDone}</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

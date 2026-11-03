import { useMemo } from 'react';
import { Check } from 'lucide-react';

import type { TodoNode } from '../../ipc/types';
import { execLabel } from '../../lib/exec';
import { formatDoneTime } from '../../lib/time';
import { useTodoStore } from '../../stores/todoStore';

interface LeafRowData {
  leaf: TodoNode;
  /** 面包屑：根 → ... → 父（不含自身）。 */
  path: string[];
}

function LeafRow({ data, onReveal }: { data: LeafRowData; onReveal: (id: string) => void }) {
  const toggle = useTodoStore(s => s.toggle);
  const { leaf, path } = data;
  const done = leaf.status === 'done';
  const exec = leaf.execution ?? null;
  const awaiting = exec?.state === 'awaiting_review';
  const failed = exec?.state === 'failed';
  return (
    <div
      onClick={() => onReveal(leaf.id)}
      className={[
        'group flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer hover:bg-surface border border-transparent hover:border-border transition-colors',
        awaiting ? 'border-l-2 border-l-warning bg-warning/5' : '',
        failed ? 'border-l-2 border-l-red-500 bg-red-500/5' : '',
      ].join(' ')}
    >
      <button
        onClick={e => {
          e.stopPropagation();
          void toggle(leaf.id);
        }}
        title={done ? '标记为待处理' : '标记为已完成'}
        className={[
          'shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors',
          done ? 'bg-success border-success' : 'border-muted hover:border-accent',
        ].join(' ')}
      >
        {done && <Check className="w-3 h-3 text-base" strokeWidth={3.5} />}
      </button>
      <div className="flex-1 min-w-0">
        <div className={['text-sm truncate', done ? 'line-through text-muted' : 'text-primary'].join(' ')}>
          {leaf.content || '未命名'}
        </div>
        {path.length > 0 && (
          <div className="text-xs text-muted/70 truncate">{path.join(' / ')}</div>
        )}
      </div>
      {!done && exec && (
        <span
          className={[
            'shrink-0 text-xs tabular-nums px-2 h-6 rounded-full inline-flex items-center',
            exec.state === 'running'
              ? 'text-accent bg-accent/10'
              : exec.state === 'awaiting_review'
                ? 'text-warning bg-warning/10'
                : exec.state === 'failed'
                  ? 'text-red-500 bg-red-500/10'
                  : 'text-muted bg-base',
          ].join(' ')}
          title={`${exec.agentName}${exec.model ? ` · ${exec.model}` : ''}`}
        >
          {execLabel(exec, Date.now())}
        </span>
      )}
      {done && (
        <span className="shrink-0 text-xs text-muted/60 tabular-nums">
          {formatDoneTime(leaf.updatedAt)}
        </span>
      )}
    </div>
  );
}

interface FlatColumnProps {
  title: string;
  count: number;
  tone: 'pending' | 'done';
  rows: LeafRowData[];
  empty: string;
  awaiting?: number;
  onReveal: (id: string) => void;
}

/** 单列：表头吸顶，列表独立滚动，两列互不影响。 */
function FlatColumn({ title, count, tone, rows, empty, awaiting = 0, onReveal }: FlatColumnProps) {
  const dot = tone === 'pending' ? 'bg-accent' : 'bg-success';
  const badge =
    tone === 'pending' ? 'bg-accent/15 text-accent' : 'bg-success/15 text-success';
  return (
    <section className="flex flex-col min-h-0 min-w-0">
      <header className="flex items-center gap-2 h-11 px-4 border-b border-border shrink-0 select-none">
        <span className={['w-1.5 h-1.5 rounded-full shrink-0', dot].join(' ')} />
        <h2 className="text-xs font-medium text-muted uppercase tracking-wider">{title}</h2>
        <span className={['px-1.5 py-0.5 rounded-full text-[11px] leading-3 tabular-nums', badge].join(' ')}>
          {count}
        </span>
        {awaiting > 0 && (
          <span className="px-1.5 py-0.5 rounded-full text-[11px] leading-3 text-warning bg-warning/10">
            待验收 {awaiting}
          </span>
        )}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
        {rows.length === 0 ? (
          <p className="px-3 py-10 text-sm text-muted/70 text-center">{empty}</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {rows.map(d => (
              <LeafRow key={d.leaf.id} data={d} onReveal={onReveal} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * 平铺视图（docs/03 §3）：只列叶子节点。
 * 「待处理」在左、「已完成」在右，双栏并列各占一半宽度，各自独立滚动，充分利用宽屏空间。
 */
export function FlatView() {
  const nodes = useTodoStore(s => s.nodes);
  const roots = useTodoStore(s => s.roots);
  const childrenOf = useTodoStore(s => s.childrenOf);
  const revealNode = useTodoStore(s => s.revealNode);

  const { pending, done } = useMemo(() => {
    const pendingList: LeafRowData[] = [];
    const doneList: LeafRowData[] = [];
    const pathOf = (n: TodoNode): string[] => {
      const parts: string[] = [];
      let cur = n.parentId;
      while (cur) {
        const p = nodes[cur];
        if (!p) break;
        parts.unshift(p.content || '未命名');
        cur = p.parentId;
      }
      return parts;
    };
    const walk = (id: string) => {
      const kids = childrenOf[id] ?? [];
      if (kids.length === 0) {
        const n = nodes[id];
        if (!n) return;
        const row = { leaf: n, path: pathOf(n) };
        if (n.status === 'pending') pendingList.push(row);
        else doneList.push(row);
        return;
      }
      for (const k of kids) walk(k);
    };
    for (const r of roots) walk(r);
    const rank = (n: TodoNode) => {
      const s = n.execution?.state;
      if (s === 'running' || s === 'queued') return 0;
      if (s === 'awaiting_review') return 1;
      return 2;
    };
    pendingList.sort((a, b) => rank(a.leaf) - rank(b.leaf));
    doneList.sort((a, b) => b.leaf.updatedAt.localeCompare(a.leaf.updatedAt));
    return { pending: pendingList, done: doneList };
  }, [nodes, roots, childrenOf]);

  const awaiting = pending.filter(d => d.leaf.execution?.state === 'awaiting_review').length;

  const onReveal = (id: string) => void revealNode(id);

  return (
    <div className="absolute inset-0 grid grid-cols-2 divide-x divide-border">
      <FlatColumn
        title="待处理"
        count={pending.length}
        tone="pending"
        rows={pending}
        awaiting={awaiting}
        empty={done.length > 0 ? '没有待处理的叶子节点，去树里看看吧' : '树还是空的，去创建第一个任务'}
        onReveal={onReveal}
      />
      <FlatColumn
        title="已完成"
        count={done.length}
        tone="done"
        rows={done}
        empty="还没有已完成的任务"
        onReveal={onReveal}
      />
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';

import type { TodoNode } from '../../ipc/types';
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
  return (
    <div
      onClick={() => onReveal(leaf.id)}
      className="group flex items-center gap-2.5 px-4 py-2 rounded-lg cursor-pointer hover:bg-surface border border-transparent hover:border-border transition-colors"
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
      {done && (
        <span className="shrink-0 text-xs text-muted/60 tabular-nums">
          {formatDoneTime(leaf.updatedAt)}
        </span>
      )}
    </div>
  );
}

/** 平铺视图（docs/03 §3）：只列叶子节点，分「待处理 / 已完成」两组。 */
export function FlatView() {
  const nodes = useTodoStore(s => s.nodes);
  const roots = useTodoStore(s => s.roots);
  const childrenOf = useTodoStore(s => s.childrenOf);
  const revealNode = useTodoStore(s => s.revealNode);
  const [doneOpen, setDoneOpen] = useState(false);

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
    doneList.sort((a, b) => b.leaf.updatedAt.localeCompare(a.leaf.updatedAt));
    return { pending: pendingList, done: doneList };
  }, [nodes, roots, childrenOf]);

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="max-w-3xl mx-auto py-4 px-3">
        {/* 待处理组 */}
        <h2 className="flex items-center gap-2 px-1 py-2 text-xs font-medium text-muted uppercase tracking-wider">
          待处理
          <span className="px-1.5 py-0.5 rounded-full bg-accent/15 text-accent text-[11px]">
            {pending.length}
          </span>
        </h2>
        {pending.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted/70 text-center">
            {done.length > 0 ? '没有待处理的叶子节点，去树里看看吧' : '树还是空的，去创建第一个任务'}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {pending.map(d => (
              <LeafRow key={d.leaf.id} data={d} onReveal={id => void revealNode(id)} />
            ))}
          </div>
        )}

        {/* 已完成组（默认折叠） */}
        <button
          onClick={() => setDoneOpen(v => !v)}
          className="flex items-center gap-2 px-1 py-2 mt-6 text-xs font-medium text-muted uppercase tracking-wider w-full text-left hover:text-primary transition-colors"
        >
          {doneOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          已完成
          <span className="px-1.5 py-0.5 rounded-full bg-success/15 text-success text-[11px] normal-case">
            {done.length}
          </span>
        </button>
        {doneOpen && (
          <div className="flex flex-col gap-0.5">
            {done.map(d => (
              <LeafRow key={d.leaf.id} data={d} onReveal={id => void revealNode(id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

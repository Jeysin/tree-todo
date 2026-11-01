/** 节点详情面板（v0.2：选中节点右侧滑出，备注编辑 600ms 防抖自动保存）。 */
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

import { formatDoneTime } from '../../lib/time';
import { useTodoStore } from '../../stores/todoStore';

export function DetailPanel() {
  const selectedId = useTodoStore(s => s.selectedId);
  const node = useTodoStore(s => (selectedId ? s.nodes[selectedId] : null));
  const updateNote = useTodoStore(s => s.updateNote);
  const select = useTodoStore(s => s.select);

  const [note, setNote] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nodeIdRef = useRef<string | null>(null);

  // 切换节点时同步本地草稿（同节点不覆盖，避免保存回来冲掉输入）
  useEffect(() => {
    if (!node) return;
    if (nodeIdRef.current !== node.id) {
      nodeIdRef.current = node.id;
      setNote(node.note);
    }
  }, [node]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  if (!node) return null;

  const onChange = (v: string) => {
    setNote(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (v !== node.note) void updateNote(node.id, v);
    }, 600);
  };

  return (
    <aside className="absolute top-0 right-0 bottom-0 w-[280px] z-20 flex flex-col border-l border-border bg-surface/95 backdrop-blur-sm shadow-xl">
      <header className="flex items-start justify-between gap-2 px-4 pt-4 pb-1">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-primary truncate" title={node.content}>
            {node.content || '未命名'}
          </h3>
          <p className="text-xs text-muted mt-1">
            <span className={node.status === 'done' ? 'text-success' : ''}>
              {node.status === 'done' ? '已完成' : '待处理'}
            </span>
            <span className="mx-1 text-border">·</span>
            {formatDoneTime(node.updatedAt)}
          </p>
        </div>
        <button
          onClick={() => select(null)}
          className="shrink-0 w-6 h-6 rounded flex items-center justify-center text-muted hover:text-primary hover:bg-base transition-colors"
          title="关闭面板"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <label className="px-4 pt-3 pb-1.5 text-xs text-muted">备注</label>
      <textarea
        value={note}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => e.stopPropagation()}
        placeholder="写点上下文、链接或想法…（自动保存）"
        spellCheck={false}
        className="flex-1 mx-4 mb-4 resize-none rounded-lg border border-border bg-base p-2.5 text-sm text-primary leading-relaxed outline-none focus:border-accent transition-colors placeholder:text-muted/50"
      />
    </aside>
  );
}

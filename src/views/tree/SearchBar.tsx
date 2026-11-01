/** 搜索浮层（docs/05 M2：Ctrl+F 全文搜索 + 结果跳转定位）。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

import { breadcrumb, useTodoStore } from '../../stores/todoStore';

interface SearchBarProps {
  open: boolean;
  onClose: () => void;
}

export function SearchBar({ open, onClose }: SearchBarProps) {
  const nodes = useTodoStore(s => s.nodes);
  const revealNode = useTodoStore(s => s.revealNode);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      // 等浮层挂载后聚焦
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return Object.values(nodes)
      .filter(n => n.content.toLowerCase().includes(q) || n.note.toLowerCase().includes(q))
      .slice(0, 30)
      .map(n => ({ node: n, path: breadcrumb({ nodes }, n.id) }));
  }, [query, nodes]);

  useEffect(() => {
    setActiveIdx(0);
  }, [results.length]);

  if (!open) return null;

  const jump = (id: string) => {
    void revealNode(id);
    onClose();
  };

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 w-[420px]">
      <div className="rounded-xl border border-border bg-elevated shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 h-10 border-b border-border">
          <Search className="w-4 h-4 text-muted shrink-0" />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索节点内容或备注…"
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIdx(i => Math.min(results.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIdx(i => Math.max(0, i - 1));
              } else if (e.key === 'Enter' && results[activeIdx]) {
                e.preventDefault();
                jump(results[activeIdx].node.id);
              }
            }}
            className="flex-1 bg-transparent outline-none text-sm text-primary placeholder:text-muted/60"
          />
          <button onClick={onClose} className="text-muted hover:text-primary transition-colors" title="关闭 (Esc)">
            <X className="w-4 h-4" />
          </button>
        </div>

        {query.trim() !== '' && (
          <div className="max-h-72 overflow-y-auto py-1">
            {results.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted/70 text-center">没有匹配的节点</p>
            ) : (
              results.map((r, i) => (
                <button
                  key={r.node.id}
                  onClick={() => jump(r.node.id)}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={[
                    'w-full text-left px-3 py-1.5 flex flex-col gap-0.5 transition-colors',
                    i === activeIdx ? 'bg-accent/12' : 'hover:bg-base',
                  ].join(' ')}
                >
                  <span className="text-sm text-primary truncate">
                    {r.node.content || '未命名'}
                    {r.node.status === 'done' && (
                      <span className="ml-2 text-xs text-success">已完成</span>
                    )}
                  </span>
                  {r.path.length > 0 && (
                    <span className="text-xs text-muted/70 truncate">{r.path.join(' / ')}</span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

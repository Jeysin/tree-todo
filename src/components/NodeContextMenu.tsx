import { useEffect, useRef } from 'react';
import { ClipboardCheck, ClipboardCopy, PanelRight, X } from 'lucide-react';

import { useRunStore } from '../stores/runStore';

export interface MenuState {
  x: number;
  y: number;
  nodeId: string;
}

export function NodeContextMenu({ state, onClose }: { state: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const openDetail = useRunStore(s => s.openDetail);
  const copyPrompt = useRunStore(s => s.copyPrompt);

  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [state, onClose]);

  if (!state) return null;
  const x = Math.min(state.x, window.innerWidth - 240);
  const y = Math.min(state.y, window.innerHeight - 200);

  return (
    <div
      ref={ref}
      data-context-menu
      style={{ left: x, top: y }}
      className="fixed z-50 w-60 rounded-lg border border-border bg-elevated shadow-xl py-1 text-[13px]"
      onContextMenu={e => e.preventDefault()}
    >
      <button
        onClick={() => {
          openDetail(state.nodeId);
          onClose();
        }}
        className="w-full flex items-center gap-2 px-3 h-8 text-left text-primary hover:bg-base"
      >
        <PanelRight className="w-3.5 h-3.5 text-muted" />
        查看详情
        <span className="ml-auto text-[11px] text-muted">Alt+Enter</span>
      </button>
      <div className="my-1 border-t border-border" />
      <button
        onClick={() => {
          void copyPrompt([state.nodeId], 'plain');
          onClose();
        }}
        className="w-full flex items-center gap-2 px-3 h-8 text-left text-primary hover:bg-base"
      >
        <ClipboardCopy className="w-3.5 h-3.5 text-muted" />
        复制 Prompt
        <span className="ml-auto text-[11px] text-muted">Ctrl+Shift+C</span>
      </button>
      <button
        onClick={() => {
          void copyPrompt([state.nodeId], 'receipt');
          onClose();
        }}
        className="w-full flex items-center gap-2 px-3 h-8 text-left text-primary hover:bg-base"
      >
        <ClipboardCheck className="w-3.5 h-3.5 text-muted" />
        复制 Prompt（带回执）
        <span className="ml-auto text-[11px] text-muted">Ctrl+Shift+R</span>
      </button>
      <div className="my-1 border-t border-border" />
      <button
        onClick={onClose}
        className="w-full flex items-center gap-2 px-3 h-8 text-left text-muted hover:bg-base"
      >
        <X className="w-3.5 h-3.5" />
        关闭
      </button>
    </div>
  );
}

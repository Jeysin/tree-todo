import { useEffect, useRef } from 'react';
import { ClipboardCheck, ClipboardCopy, PanelRight, X } from 'lucide-react';

import { useRunStore } from '../stores/runStore';

export interface MenuState {
  x: number;
  y: number;
  nodeId: string;
  /** 复制 Prompt 的作用范围：右键点在多选内时是整个选区，否则只有 nodeId。 */
  nodeIds: string[];
}

/** 菜单宽度（px）：需容下最长项「复制 Prompt（带回执）」+ 快捷键，避免折行。 */
const MENU_WIDTH = 288;
/** 单项行高（h-8）+ 分隔线，用于贴边翻转。 */
const MENU_HEIGHT = 180;

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
  const x = Math.min(state.x, window.innerWidth - MENU_WIDTH - 8);
  const y = Math.min(state.y, window.innerHeight - MENU_HEIGHT - 8);
  const multi = state.nodeIds.length > 1;

  return (
    <div
      ref={ref}
      data-context-menu
      style={{ left: x, top: y, width: MENU_WIDTH }}
      className="fixed z-50 rounded-lg border border-border bg-elevated shadow-xl py-1 text-[12px] whitespace-nowrap"
      onContextMenu={e => e.preventDefault()}
    >
      <button
        onClick={() => {
          openDetail(state.nodeId);
          onClose();
        }}
        className="w-full flex items-center gap-2 px-3 h-8 text-left text-primary hover:bg-base"
      >
        <PanelRight className="w-3.5 h-3.5 shrink-0 text-muted" />
        <span className="min-w-0 truncate">查看详情</span>
        <span className="ml-auto shrink-0 text-[10.5px] text-muted">Alt+Enter</span>
      </button>
      <div className="my-1 border-t border-border" />
      <button
        onClick={() => {
          void copyPrompt(state.nodeIds, 'plain');
          onClose();
        }}
        className="w-full flex items-center gap-2 px-3 h-8 text-left text-primary hover:bg-base"
      >
        <ClipboardCopy className="w-3.5 h-3.5 shrink-0 text-muted" />
        <span className="min-w-0 truncate">复制 Prompt</span>
        {multi && <span className="shrink-0 text-[10.5px] text-accent">×{state.nodeIds.length}</span>}
        <span className="ml-auto shrink-0 text-[10.5px] text-muted">Ctrl+Shift+C</span>
      </button>
      <button
        onClick={() => {
          void copyPrompt(state.nodeIds, 'receipt');
          onClose();
        }}
        className="w-full flex items-center gap-2 px-3 h-8 text-left text-primary hover:bg-base"
      >
        <ClipboardCheck className="w-3.5 h-3.5 shrink-0 text-muted" />
        <span className="min-w-0 truncate">复制 Prompt（带回执）</span>
        {multi && <span className="shrink-0 text-[10.5px] text-accent">×{state.nodeIds.length}</span>}
        <span className="ml-auto shrink-0 text-[10.5px] text-muted">Ctrl+Shift+R</span>
      </button>
      <div className="my-1 border-t border-border" />
      <button
        onClick={onClose}
        className="w-full flex items-center gap-2 px-3 h-8 text-left text-muted hover:bg-base"
      >
        <X className="w-3.5 h-3.5 shrink-0" />
        <span className="min-w-0 truncate">关闭</span>
      </button>
    </div>
  );
}

import { useEffect, useRef } from 'react';
import {
  ClipboardCheck,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  PanelRight,
  Trash2,
  X,
} from 'lucide-react';

import { useT } from '../i18n';
import { useRunStore } from '../stores/runStore';
import { useTodoStore } from '../stores/todoStore';

export interface MenuState {
  x: number;
  y: number;
  nodeId: string;
  /** 复制 Prompt 的作用范围：右键点在多选内时是整个选区，否则只有 nodeId。 */
  nodeIds: string[];
}

/** 菜单宽度（px）：需容下最长项「复制 Prompt（带回执）」+ 快捷键，避免折行。 */
const MENU_WIDTH = 288;
/** 7 个单项（h-8）+ 4 条分隔线 + 上下内边距，用于贴边翻转。 */
const MENU_HEIGHT = 276;

export function NodeContextMenu({ state, onClose }: { state: MenuState | null; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const openDetail = useRunStore(s => s.openDetail);
  const copyPrompt = useRunStore(s => s.copyPrompt);
  const clipboard = useTodoStore(s => s.clipboard);
  const copyNodes = useTodoStore(s => s.copyNodes);
  const pasteNodes = useTodoStore(s => s.pasteNodes);
  const requestDelete = useTodoStore(s => s.requestDelete);
  /** 根任务受保护：删除项置灰（与 Del 键「根任务不可删除」一致）。 */
  const isRoot = useTodoStore(s => (state ? s.nodes[state.nodeId]?.parentId === null : false));

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
        <span className="min-w-0 truncate">{t('查看详情')}</span>
        <span className="ml-auto shrink-0 text-[10.5px] text-muted">Alt+Enter</span>
      </button>
      <div className="my-1 border-t border-border" />
      <button
        onClick={() => {
          void copyNodes(state.nodeIds);
          onClose();
        }}
        className="w-full flex items-center gap-2 px-3 h-8 text-left text-primary hover:bg-base"
      >
        <Copy className="w-3.5 h-3.5 shrink-0 text-muted" />
        <span className="min-w-0 truncate">{t('复制节点（含子树）')}</span>
        <span className="ml-auto shrink-0 text-[10.5px] text-muted">⌘/Ctrl+C</span>
      </button>
      <button
        disabled={!clipboard}
        title={
          clipboard
            ? t('来自「{name}」：{summary}（共 {n} 个节点）', {
                name: clipboard.sourceDocName || t('其他文档'),
                summary: clipboard.summary,
                n: clipboard.totalCount,
              })
            : t('请先复制节点')
        }
        onClick={() => {
          void pasteNodes(state.nodeId);
          onClose();
        }}
        className="w-full flex items-center gap-2 px-3 h-8 text-left text-primary hover:bg-base disabled:text-muted disabled:hover:bg-transparent disabled:cursor-not-allowed"
      >
        <ClipboardPaste className="w-3.5 h-3.5 shrink-0 text-muted" />
        <span className="min-w-0 truncate">{t('粘贴为子节点')}</span>
        <span className="ml-auto shrink-0 text-[10.5px] text-muted">⌘/Ctrl+V</span>
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
        <span className="min-w-0 truncate">{t('复制 Prompt')}</span>
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
        <span className="min-w-0 truncate">{t('复制 Prompt（带回执）')}</span>
        <span className="ml-auto shrink-0 text-[10.5px] text-muted">Ctrl+Shift+R</span>
      </button>
      <div className="my-1 border-t border-border" />
      <button
        disabled={isRoot}
        title={isRoot ? t('根任务不可删除') : undefined}
        onClick={() => {
          requestDelete(state.nodeIds);
          onClose();
        }}
        className="w-full flex items-center gap-2 px-3 h-8 text-left text-red-500 hover:bg-red-500/10 disabled:text-muted disabled:hover:bg-transparent disabled:cursor-not-allowed"
      >
        <Trash2 className="w-3.5 h-3.5 shrink-0" />
        <span className="min-w-0 truncate">{t('删除节点')}</span>
        <span className="ml-auto shrink-0 text-[10.5px] text-muted">Del</span>
      </button>
      <div className="my-1 border-t border-border" />
      <button
        onClick={onClose}
        className="w-full flex items-center gap-2 px-3 h-8 text-left text-muted hover:bg-base"
      >
        <X className="w-3.5 h-3.5 shrink-0" />
        <span className="min-w-0 truncate">{t('关闭')}</span>
      </button>
    </div>
  );
}

/**
 * 树形视图的自定义节点（docs/04 §3.2 节点视觉规格）。
 * 数据本体从 store 实时读取，react-flow 节点只携带布局信息。
 */
import { memo, useEffect, useRef } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';

import { useTodoStore } from '../../stores/todoStore';

export interface TodoNodeData {
  /** react-flow Node 数据约束：需要 index signature。 */
  [key: string]: unknown;
  nodeId: string;
  width: number;
  /** 折叠状态下被隐藏的直接子节点数（+N 角标）。 */
  hiddenCount: number;
  /** 直接子节点数（折叠钮仅在有子节点时显示）。 */
  childCount: number;
}

export type TodoFlowNode = Node<TodoNodeData>;

function TodoNodeView({ data }: NodeProps<TodoFlowNode>) {
  const { nodeId } = data;

  const node = useTodoStore(s => s.nodes[nodeId]);
  const isEditing = useTodoStore(s => s.editingId === nodeId);
  const isSelected = useTodoStore(s => s.selectedId === nodeId);
  const isFlashing = useTodoStore(s => s.flashId === nodeId);
  const draft = useTodoStore(s => s.draft);

  const select = useTodoStore(s => s.select);
  const setEditing = useTodoStore(s => s.setEditing);
  const setDraft = useTodoStore(s => s.setDraft);
  const updateContent = useTodoStore(s => s.updateContent);
  const toggle = useTodoStore(s => s.toggle);
  const setCollapsed = useTodoStore(s => s.setCollapsed);
  const createChild = useTodoStore(s => s.createChild);
  const createSibling = useTodoStore(s => s.createSibling);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  if (!node) return null; // removed 快照同步前的瞬时保护

  const done = node.status === 'done';

  const submit = () => {
    if (draft !== node.content) {
      void updateContent(nodeId, draft);
    } else {
      setEditing(null);
    }
  };

  return (
    <div
      onClick={() => select(nodeId)}
      onDoubleClick={() => setEditing(nodeId)}
      style={{ width: data.width, minHeight: 44 }}
      className={[
        'group relative flex items-center gap-2 px-2 py-1 rounded-lg border text-sm select-none',
        'bg-surface border-border shadow-sm transition-all duration-150 hover:shadow-md',
        done ? 'opacity-45' : '',
        isSelected ? 'border-accent ring-1 ring-accent' : 'hover:border-muted',
        isFlashing ? 'node-flash' : '',
      ].join(' ')}
    >
      {/* 锚点（隐藏，仅供连线定位） */}
      <Handle type="target" position={Position.Left} isConnectable={false} className="!invisible" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="!invisible" />

      {/* 状态 checkbox（docs/04 §3.2：命中区域扩大的空心/实心圆） */}
      <button
        onClick={e => {
          e.stopPropagation();
          void toggle(nodeId);
        }}
        title={done ? '标记为待处理' : '标记为已完成'}
        className={[
          'shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors',
          done
            ? 'bg-success border-success'
            : 'border-muted hover:border-accent active:scale-90',
        ].join(' ')}
      >
        {done && <Check className="w-3 h-3 text-base" strokeWidth={3.5} />}
      </button>

      {/* 内容 / 编辑输入框 */}
      {isEditing ? (
        <input
          ref={inputRef}
          value={draft}
          spellCheck={false}
          onChange={e => setDraft(e.target.value)}
          onBlur={submit}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
              void createSibling(nodeId);
            } else if (e.key === 'Tab') {
              e.preventDefault();
              submit();
              void createChild(nodeId);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(null);
            }
          }}
          className="flex-1 min-w-0 bg-transparent outline-none text-primary"
        />
      ) : (
        <span
          className={[
            'flex-1 truncate',
            done ? 'line-through text-muted' : 'text-primary',
          ].join(' ')}
        >
          {node.content || <span className="text-muted/50">未命名</span>}
        </span>
      )}

      {/* 折叠 / 展开钮（docs/04 §2.4：仅有子节点时显示，折叠时带 +N 角标） */}
      {data.childCount > 0 && (
        <button
          onClick={e => {
            e.stopPropagation();
            void setCollapsed(nodeId, !node.collapsed);
          }}
          title={node.collapsed ? `展开（${data.hiddenCount} 个子节点）` : '折叠'}
          className="shrink-0 relative w-5 h-5 rounded flex items-center justify-center text-muted hover:text-primary hover:bg-base transition-colors"
        >
          {node.collapsed ? (
            <ChevronRight className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
          {node.collapsed && data.hiddenCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-0.5 rounded-full bg-accent text-[10px] leading-4 text-center text-white font-medium">
              {data.hiddenCount}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

export const TodoNode = memo(TodoNodeView);

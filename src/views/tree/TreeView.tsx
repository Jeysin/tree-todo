/**
 * 树形（脑图）视图：react-flow 画布 + 全键盘操作流（docs/03 §2、§4；docs/04 §5）。
 * 职责：渲染布局结果、维护焦点移动、视口跟随、删除确认与空态引导。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  useReactFlow,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useTodoStore } from '../../stores/todoStore';
import { countDescendants, computeLayout, NODE_H } from './layout';
import { TodoNode, type TodoFlowNode } from './TodoNode';

const nodeTypes: NodeTypes = { todo: TodoNode };

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 mx-0.5 rounded border border-border bg-elevated text-[11px] text-primary">
      {children}
    </kbd>
  );
}

function EmptyHint() {
  const createChild = useTodoStore(s => s.createChild);
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="text-center pointer-events-auto">
        <p className="text-lg font-medium text-primary mb-3">从这里开始你的第一条任务线</p>
        <p className="text-sm text-muted mb-6">
          按 <Kbd>N</Kbd> 创建根节点，<Kbd>Tab</Kbd> 拆解子任务，<Kbd>Space</Kbd> 完成它
        </p>
        <button
          onClick={() => void createChild(null)}
          className="px-4 h-9 rounded-lg bg-accent text-white text-sm hover:opacity-90 transition-opacity"
        >
          + 创建第一个任务
        </button>
      </div>
    </div>
  );
}

/** 删除确认条（docs/04 §4.4：非模态内联确认）。 */
function ConfirmBar() {
  const id = useTodoStore(s => s.confirmDeleteId);
  const node = useTodoStore(s => (id ? s.nodes[id] : null));
  const childrenOf = useTodoStore(s => s.childrenOf);
  const remove = useTodoStore(s => s.remove);
  const setConfirmDelete = useTodoStore(s => s.setConfirmDelete);

  if (!id || !node) return null;
  const desc = countDescendants(id, childrenOf);
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 rounded-lg bg-elevated border border-border shadow-xl text-sm whitespace-nowrap">
      <span className="text-primary">
        删除「{node.content || '未命名'}」
        {desc > 0 && <span className="text-warning">及其 {desc} 个子节点</span>}？
      </span>
      <span className="flex gap-2">
        <button
          onClick={() => void remove(id)}
          className="px-2.5 py-1 rounded bg-red-500/90 text-white hover:bg-red-500 transition-colors"
        >
          删除
        </button>
        <button
          onClick={() => setConfirmDelete(null)}
          className="px-2.5 py-1 rounded border border-border text-primary hover:bg-base transition-colors"
        >
          取消
        </button>
      </span>
    </div>
  );
}

export function TreeView() {
  const { setCenter, getZoom, fitView } = useReactFlow();

  const nodes = useTodoStore(s => s.nodes);
  const roots = useTodoStore(s => s.roots);
  const childrenOf = useTodoStore(s => s.childrenOf);
  const loaded = useTodoStore(s => s.loaded);
  const viewMode = useTodoStore(s => s.viewMode);
  const revealTarget = useTodoStore(s => s.revealTarget);
  const centerTarget = useTodoStore(s => s.centerTarget);

  const layout = useMemo(
    () => computeLayout(nodes, roots, childrenOf),
    [nodes, roots, childrenOf],
  );

  const rfNodes = useMemo<TodoFlowNode[]>(
    () =>
      layout.nodes.map(p => ({
        id: p.id,
        type: 'todo' as const,
        position: { x: p.x, y: p.y },
        data: {
          nodeId: p.id,
          width: p.width,
          hiddenCount: (childrenOf[p.id] ?? []).length,
          childCount: (childrenOf[p.id] ?? []).length,
        },
        draggable: false,
        selectable: false,
        deletable: false,
      })),
    [layout, childrenOf],
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      layout.edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        style: {
          stroke: 'var(--text-muted)',
          strokeWidth: 1.5,
          opacity: e.done ? 0.16 : 0.42,
        },
      })),
    [layout],
  );

  const posById = useMemo(() => new Map(layout.nodes.map(p => [p.id, p])), [layout]);

  /** 视口居中到节点（保持给定缩放）。 */
  const centerOn = useCallback(
    (id: string, zoom: number, duration = 300) => {
      const p = posById.get(id);
      if (!p) return;
      void setCenter(p.x + p.width / 2, p.y + NODE_H / 2, { zoom, duration });
    },
    [posById, setCenter],
  );

  // 首次加载 → 适应整树
  const fittedRef = useRef(false);
  useEffect(() => {
    if (loaded && !fittedRef.current && layout.nodes.length > 0) {
      fittedRef.current = true;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 400 })),
      );
    }
  }, [loaded, layout.nodes.length, fitView]);

  // 平铺视图跳转定位（docs/03 §3.3）
  useEffect(() => {
    if (!revealTarget) return;
    if (posById.has(revealTarget.id)) {
      centerOn(revealTarget.id, 1, 400);
      useTodoStore.setState({ revealTarget: null });
    }
  }, [revealTarget, posById, centerOn]);

  // 新建节点视口跟随（保持当前缩放）
  useEffect(() => {
    if (!centerTarget) return;
    if (posById.has(centerTarget.id)) {
      centerOn(centerTarget.id, getZoom(), 350);
      useTodoStore.setState({ centerTarget: null });
    }
  }, [centerTarget, posById, centerOn, getZoom]);

  // 全键盘操作流（docs/03 §4）
  useEffect(() => {
    if (viewMode !== 'tree') return;
    const onKey = (e: KeyboardEvent) => {
      const st = useTodoStore.getState();
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (st.editingId) return;

      const id = st.selectedId;
      const node = id ? st.nodes[id] : undefined;
      switch (e.key) {
        case 'n':
        case 'N':
          e.preventDefault();
          void st.createChild(null);
          break;
        case 'Tab':
          if (id) {
            e.preventDefault();
            void st.createChild(id);
          }
          break;
        case 'Enter':
          if (id) {
            e.preventDefault();
            void st.createSibling(id);
          }
          break;
        case ' ':
          if (id) {
            e.preventDefault();
            void st.toggle(id);
          }
          break;
        case 'Delete':
          if (id) {
            e.preventDefault();
            st.setConfirmDelete(id);
          }
          break;
        case 'Backspace':
          // 内容为空的节点才允许 Backspace 触发删除（避免误删）
          if (id && st.nodes[id]?.content === '') {
            e.preventDefault();
            st.setConfirmDelete(id);
          }
          break;
        case 'F2':
          if (id) {
            e.preventDefault();
            st.setEditing(id);
          }
          break;
        case 'Escape':
          st.setConfirmDelete(null);
          break;
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault();
          const order = layout.dfsOrder;
          if (order.length === 0) return;
          const idx = id ? order.indexOf(id) : -1;
          const nextIdx =
            e.key === 'ArrowUp'
              ? idx <= 0
                ? 0
                : idx - 1
              : idx === -1
                ? 0
                : Math.min(order.length - 1, idx + 1);
          const nextId = order[nextIdx];
          if (nextId && nextId !== id) {
            st.select(nextId);
            centerOn(nextId, getZoom(), 250);
          }
          break;
        }
        case 'ArrowLeft':
          if (id && node) {
            e.preventDefault();
            if (!node.collapsed && (st.childrenOf[id] ?? []).length > 0) {
              void st.setCollapsed(id, true);
            } else if (node.parentId) {
              st.select(node.parentId);
            }
          }
          break;
        case 'ArrowRight':
          if (id && node?.collapsed) {
            e.preventDefault();
            void st.setCollapsed(id, false);
          }
          break;
        case '1':
          // Shift+1 适应整树视图
          if (e.shiftKey) {
            e.preventDefault();
            void fitView({ padding: 0.15, duration: 400 });
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewMode, layout.dfsOrder, centerOn, getZoom, fitView]);

  return (
    <div className="absolute inset-0">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, n) => useTodoStore.getState().select(n.id)}
        onPaneClick={() => useTodoStore.getState().select(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={4}
        fitView={false}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1.2}
          color="var(--border-color)"
        />
      </ReactFlow>
      {loaded && roots.length === 0 && <EmptyHint />}
      <ConfirmBar />
    </div>
  );
}

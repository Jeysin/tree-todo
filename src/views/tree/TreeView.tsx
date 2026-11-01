/**
 * 树形（脑图）视图：react-flow 画布 + 全键盘操作流（docs/03 §2、§4；docs/04 §5）。
 * v0.2：拖拽移动（成为子节点 / 插入为其后兄弟）、Alt+↑↓ 同级排序、Ctrl+F 搜索、
 * 备注详情面板、静默删除（toast 撤销）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { AppIcon } from '../../components/AppIcon';
import { useTodoStore } from '../../stores/todoStore';
import { DetailPanel } from './DetailPanel';
import { computeLayout, NODE_H } from './layout';
import { SearchBar } from './SearchBar';
import { TodoNode, type TodoFlowNode, type TodoNodeData } from './TodoNode';

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
        <AppIcon size={84} className="mx-auto mb-7 drop-shadow-2xl rounded-[22px]" />
        <p className="text-lg font-medium text-primary mb-3">从这里开始你的第一条任务线</p>
        <p className="text-sm text-muted mb-6">
          按 <Kbd>N</Kbd> 创建根节点，<Kbd>Tab</Kbd> 拆解子任务，<Kbd>Space</Kbd> 完成它
        </p>
        <button
          onClick={() => void createChild(null)}
          className="px-4 h-9 rounded-lg bg-accent text-white text-sm shadow-sm hover:brightness-110 active:scale-[0.98] transition-all"
        >
          + 创建第一个任务
        </button>
      </div>
    </div>
  );
}

/** 由布局结果构建 react-flow 节点（位置来自布局，拖拽期间由 onNodesChange 临时覆盖）。 */
function buildNodes(
  layout: ReturnType<typeof computeLayout>,
  childrenOf: Record<string, string[]>,
): TodoFlowNode[] {
  return layout.nodes.map(p => ({
    id: p.id,
    type: 'todo' as const,
    position: { x: p.x, y: p.y },
    data: {
      nodeId: p.id,
      width: p.width,
      hiddenCount: (childrenOf[p.id] ?? []).length,
      childCount: (childrenOf[p.id] ?? []).length,
    },
    draggable: true,
    selectable: false,
    deletable: false,
  }));
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
  const searchOpen = useTodoStore(s => s.searchOpen);
  const setSearchOpen = useTodoStore(s => s.setSearchOpen);

  const layout = useMemo(
    () => computeLayout(nodes, roots, childrenOf),
    [nodes, roots, childrenOf],
  );

  // 节点位置状态：布局变化时重建；拖拽中由 applyNodeChanges 维护临时位置
  const [rfNodes, setRfNodes] = useState<TodoFlowNode[]>([]);
  useEffect(() => {
    setRfNodes(buildNodes(layout, childrenOf));
  }, [layout, childrenOf]);

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

  const onNodesChange = useCallback((changes: NodeChange<TodoFlowNode>[]) => {
    setRfNodes(nds => applyNodeChanges(changes, nds));
  }, []);

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

  // ── 拖拽移动（v0.2）────────────────────────────────
  /** 节点自身或其子孙不可作为拖拽目标（防环的 UI 侧过滤，Rust 侧仍二次校验）。 */
  const isSelfOrDescendant = useCallback(
    (candidate: string, draggedId: string) => {
      let cur: string | null = draggedId;
      while (cur) {
        if (cur === candidate) return true;
        cur = useTodoStore.getState().nodes[cur]?.parentId ?? null;
      }
      return false;
    },
    [],
  );

  const onNodeDrag = useCallback(
    (_: MouseEvent | TouchEvent, dragged: TodoFlowNode) => {
      const width = (dragged.data as TodoNodeData).width ?? 120;
      const cx = dragged.position.x + width / 2;
      const cy = dragged.position.y + NODE_H / 2;
      let targetId: string | null = null;
      let mode: 'child' | 'sibling' | null = null;
      for (const p of layout.nodes) {
        if (isSelfOrDescendant(p.id, dragged.id)) continue;
        // 卡片范围内 → 成为其子节点
        if (cx >= p.x - 8 && cx <= p.x + p.width + 8 && cy >= p.y && cy <= p.y + NODE_H) {
          targetId = p.id;
          mode = 'child';
          break;
        }
        // 卡片正下方窄带 → 插为其后兄弟
        if (cx >= p.x && cx <= p.x + p.width && cy > p.y + NODE_H && cy <= p.y + NODE_H + 24) {
          targetId = p.id;
          mode = 'sibling';
          break;
        }
      }
      useTodoStore.getState().setDropTarget(targetId, mode);
    },
    [layout, isSelfOrDescendant],
  );

  const onNodeDragStop = useCallback(
    (_: MouseEvent | TouchEvent, dragged: TodoFlowNode) => {
      const st = useTodoStore.getState();
      const targetId = st.dropTargetId;
      const mode = st.dropMode;
      st.setDropTarget(null, null);

      if (!targetId) {
        // 拖到空白：非根节点移到根末尾；根节点保持原位
        const cur = st.nodes[dragged.id];
        if (cur && cur.parentId !== null) {
          void st.moveNode(dragged.id, null);
        }
        setRfNodes(buildNodes(layout, childrenOf));
        return;
      }

      if (mode === 'child') {
        void st.moveNode(dragged.id, targetId, null);
      } else {
        // 兄弟：插入到目标之后（分数定位取中点）
        const t = st.nodes[targetId];
        if (t) {
          const siblings = t.parentId === null ? st.roots : (st.childrenOf[t.parentId] ?? []);
          const idx = siblings.indexOf(t.id);
          const nextNode =
            idx >= 0 && idx + 1 < siblings.length ? st.nodes[siblings[idx + 1]] : null;
          const pos = nextNode ? (t.position + nextNode.position) / 2 : t.position + 1024;
          void st.moveNode(dragged.id, t.parentId, pos);
        } else {
          void st.moveNode(dragged.id, targetId, null);
        }
      }
      // 复位视觉位置（成功时布局随后会再次重建）
      setRfNodes(buildNodes(layout, childrenOf));
    },
    [layout, childrenOf],
  );

  // ── 全键盘操作流（docs/03 §4；v0.2 增补搜索 / Alt 排序 / 静默删除）──
  useEffect(() => {
    if (viewMode !== 'tree') return;
    const onKey = (e: KeyboardEvent) => {
      const st = useTodoStore.getState();
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (st.editingId) return;

      const mod = e.ctrlKey || e.metaKey;

      // Ctrl+F 搜索
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        st.setSearchOpen(true);
        return;
      }

      const id = st.selectedId;
      const node = id ? st.nodes[id] : undefined;

      // Alt+↑ / Alt+↓ 同级排序
      if (e.altKey && id && node && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const siblings =
          node.parentId === null ? st.roots : (st.childrenOf[node.parentId] ?? []);
        const idx = siblings.indexOf(id);
        if (e.key === 'ArrowUp' && idx > 0) {
          const prev = st.nodes[siblings[idx - 1]];
          const prevPrev = idx >= 2 ? st.nodes[siblings[idx - 2]] : null;
          const pos = prevPrev ? (prevPrev.position + prev.position) / 2 : prev.position - 1024;
          void st.moveNode(id, node.parentId, pos);
        } else if (e.key === 'ArrowDown' && idx >= 0 && idx < siblings.length - 1) {
          const next = st.nodes[siblings[idx + 1]];
          const nextNext = idx + 2 < siblings.length ? st.nodes[siblings[idx + 2]] : null;
          const pos = nextNext ? (next.position + nextNext.position) / 2 : next.position + 1024;
          void st.moveNode(id, node.parentId, pos);
        }
        return;
      }

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
            void st.remove(id);
          }
          break;
        case 'Backspace':
          if (id && st.nodes[id]?.content === '') {
            e.preventDefault();
            void st.remove(id);
          }
          break;
        case 'F2':
          if (id) {
            e.preventDefault();
            st.setEditing(id);
          }
          break;
        case 'Escape':
          st.setSearchOpen(false);
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
        onNodesChange={onNodesChange}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_, n) => useTodoStore.getState().select(n.id)}
        onPaneClick={() => useTodoStore.getState().select(null)}
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
      <SearchBar open={searchOpen} onClose={() => setSearchOpen(false)} />
      <DetailPanel />
    </div>
  );
}

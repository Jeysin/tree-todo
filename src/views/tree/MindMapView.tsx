/**
 * 树形（脑图）视图：Mind Elixir 负责全部脑图交互（展开/收起、拖拽、折叠角标、平移缩放、键盘导航），
 * 本组件只做「Rust 快照 ↔ Mind Elixir」适配 + 待办 checkbox / 状态显示。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import MindElixir from 'mind-elixir';
import type { Theme, Topic } from 'mind-elixir';
import 'mind-elixir/style.css';

import { NodeContextMenu, type MenuState } from '../../components/NodeContextMenu';
import { ipc } from '../../ipc';
import type { Affected as TodoAffected, TodoNode } from '../../ipc/types';
import { execLabel } from '../../lib/exec';
import { useRunStore } from '../../stores/runStore';
import { useTodoStore } from '../../stores/todoStore';
import { setMindMapControls } from './mindmapApi';
import {
  buildMindElixirData,
  decorateTopic,
  dropPosition,
  moveAdjacentPosition,
  nodeObjFromStore,
  readMindColors,
  siblingInsertPosition,
  treeSignature,
  type TodoNodeObj,
} from './mindmapData';
import {
  applyViewport,
  loadViewport,
  readViewport,
  saveViewport,
} from './mindmapViewport';
import { SearchBar } from './SearchBar';

const THEME: Theme = {
  name: 'tree-todo',
  type: 'light',
  palette: [
    'var(--accent)',
    'var(--accent)',
    'var(--accent)',
    'var(--accent)',
    'var(--accent)',
  ],
  cssVar: {
    '--node-gap-x': '40px',
    '--node-gap-y': '8px',
    '--main-gap-x': '64px',
    '--main-gap-y': '8px',
    '--main-color': 'var(--accent)',
    '--main-bgcolor': 'var(--bg-surface)',
    '--main-bgcolor-transparent': 'transparent',
    '--main-border': '1px solid var(--border-color)',
    '--color': 'var(--text-primary)',
    '--bgcolor': 'var(--bg-base)',
    '--selected': 'var(--accent)',
    '--accent-color': 'var(--accent)',
    '--root-color': '#ffffff',
    '--root-bgcolor': 'var(--accent)',
    '--root-border-color': 'var(--accent)',
    '--root-radius': '8px',
    '--main-radius': '6px',
    '--topic-padding': '4px 8px',
    '--panel-color': 'var(--text-primary)',
    '--panel-bgcolor': 'var(--bg-elevated)',
    '--panel-border-color': 'var(--border-color)',
    '--map-padding': '56px',
  },
};

type TopicWithText = Topic & { text?: HTMLElement };

/**
 * 从 DOM 元素的 `data-nodeid` 解析节点 id。
 * Mind Elixir 给 me-tpc 写的是 `me${id}`（它的 findEle 就按这个前缀查），
 * 我们自己的元素（如 .todo-check）则没有前缀 —— 统一在这里剥掉。
 */
export function nodeIdFromEl(el: Element | null | undefined): string | null {
  const raw = el?.getAttribute('data-nodeid');
  if (!raw) return null;
  return raw.startsWith('me') ? raw.slice(2) : raw;
}

function tdNodeObj(tpc: TopicWithText): TodoNodeObj | null {
  return (tpc.nodeObj as TodoNodeObj | null) ?? null;
}

function findTopic(mind: MindElixir, id: string): TopicWithText | null {
  if (!mind.el) return null;
  try {
    return mind.findEle(id) as TopicWithText;
  } catch {
    // 节点折叠时 findEle 会抛错；调用方按“不在 DOM”处理。
    return null;
  }
}

function decorateAll(mind: MindElixir, onToggle: (id: string) => void): void {
  if (!mind.el) return;
  for (const el of Array.from(mind.el.querySelectorAll<HTMLElement>('me-tpc'))) {
    const tpc = el as TopicWithText;
    const obj = tdNodeObj(tpc);
    if (obj) decorateTopic(tpc, obj, onToggle);
  }
}

function mergeAffected(list: TodoAffected[]): TodoAffected {
  const upserted = new Map<string, TodoNode>();
  const removed = new Set<string>();
  for (const af of list) {
    for (const n of af.upserted) upserted.set(n.id, n);
    for (const id of af.removed) removed.add(id);
  }
  return {
    upserted: Array.from(upserted.values()),
    removed: Array.from(removed),
  };
}

/** 把 Rust 返回的受影响快照应用到 Mind Elixir 现有节点（不改结构，只改状态/内容/连线颜色）。 */
function applyAffectedToMind(
  mind: MindElixir,
  af: TodoAffected,
  onToggle: (id: string) => void,
): void {
  if (!mind.nodeData) return;
  const colors = readMindColors();
  for (const n of af.upserted) {
    const obj = mind.getObjById(n.id, mind.nodeData) as TodoNodeObj | null;
    if (!obj) continue;
    obj.topic = n.content;
    obj.metadata = { status: n.status, root: n.parentId === null };
    obj.branchColor = n.status === 'done' ? colors.muted : colors.accent;
    const tpc = findTopic(mind, n.id);
    if (tpc) decorateTopic(tpc, obj, onToggle);
  }
  mind.linkDiv();
}

function syncNodeMetadata(
  mind: MindElixir,
  nodes: Record<string, TodoNode>,
  onToggle: (id: string) => void,
): void {
  const colors = readMindColors();
  for (const n of Object.values(nodes)) {
    const obj = mind.getObjById(n.id, mind.nodeData) as TodoNodeObj | null;
    if (!obj) continue;
    obj.topic = n.content;
    // execution 必须带上 —— 徽标数据源就是它。漏掉会导致派发后徽标永不出现。
    obj.metadata = { status: n.status, root: n.parentId === null, execution: n.execution ?? null };
    obj.branchColor = n.status === 'done' ? colors.muted : colors.accent;
    const tpc = findTopic(mind, n.id);
    if (tpc) decorateTopic(tpc, obj, onToggle);
  }
  mind.linkDiv();
}

function updateBranchColors(mind: MindElixir): void {
  const colors = readMindColors();
  const visit = (obj: TodoNodeObj | null) => {
    if (!obj) return;
    obj.branchColor = obj.metadata?.status === 'done' ? colors.muted : colors.accent;
    for (const child of obj.children ?? []) visit(child as TodoNodeObj);
  };
  visit(mind.nodeData as TodoNodeObj);
  mind.linkDiv();
}

function currentRootId(): string | null {
  return useTodoStore.getState().roots[0] ?? null;
}

/** 供内部 override 使用的创建流程：先 Rust 建节点，再让 Mind Elixir 本地插入。 */
async function createNodeInMind(
  mind: MindElixir,
  parentId: string,
  position: number | null,
  skipSync: () => void,
): Promise<{ id: string; nodeObj: TodoNodeObj } | null> {
  try {
    const r = await ipc.createNode(parentId, '', position);
    skipSync();
    const st = useTodoStore.getState();
    st.applyAffected({ upserted: r.upserted, removed: [] });
    st.select(r.newId);
    if (!mind.nodeData) return null;
    const snap = useTodoStore.getState();
    const rootId = snap.roots[0];
    if (!rootId) return null;
    const nodeObj = nodeObjFromStore(
      snap.nodes,
      snap.childrenOf,
      rootId,
      r.newId,
      readMindColors(),
    );
    if (!nodeObj) return null;
    applyAffectedToMind(mind, { upserted: r.upserted, removed: [] }, id => void toggleNodeInMind(mind, id));
    return { id: r.newId, nodeObj };
  } catch (e) {
    useTodoStore.getState().showToast(errText(e, '创建节点失败'));
    return null;
  }
}

/** 顶层入口（N / 顶栏按钮）：先 Rust 建节点，再挂到父节点并进入编辑。 */
async function createChildAndEdit(
  mind: MindElixir,
  parentId: string,
  position: number | null,
  skipSync: () => void,
): Promise<void> {
  const created = await createNodeInMind(mind, parentId, position, skipSync);
  if (!created) return;
  const parentTpc = findTopic(mind, parentId);
  if (!parentTpc) {
    void useTodoStore.getState().loadTree();
    return;
  }
  await mind.addChild(parentTpc, created.nodeObj);
  const tpc = findTopic(mind, created.id);
  if (tpc) {
    mind.selectNode(tpc);
    void mind.beginEdit(tpc);
    mind.scrollIntoView(tpc);
  }
}

async function toggleNodeInMind(mind: MindElixir, id: string): Promise<void> {
  try {
    const af = await ipc.toggleStatus(id);
    const st = useTodoStore.getState();
    st.applyAffected(af);
    st.select(id);
    if (!mind.nodeData) return;
    applyAffectedToMind(mind, af, nextId => void toggleNodeInMind(mind, nextId));
  } catch (e) {
    useTodoStore.getState().showToast(errText(e, '状态切换失败'));
  }
}

function errText(e: unknown, fallback: string): string {
  const ae = e as { message?: unknown } | null;
  return ae && typeof ae.message === 'string' && ae.message ? ae.message : fallback;
}

function installMindBehavior(
  mind: MindElixir,
  skipSync: () => void,
  onToggle: (id: string) => void,
): void {
  // 1) 所有新节点 / 根节点都加 checkbox；保留内置 .text 引用，inline 编辑不受影响。
  const baseCreateWrapper = mind.createWrapper.bind(mind);
  mind.createWrapper = (nodeObj, omitChildren) => {
    const res = baseCreateWrapper(nodeObj, omitChildren);
    decorateTopic(res.tpc as TopicWithText, nodeObj, onToggle);
    return res;
  };

  const baseLayout = mind.layout.bind(mind);
  mind.layout = () => {
    baseLayout();
    decorateAll(mind, onToggle);
  };

  // 2) 新建：Rust 先生成 ID，Mind Elixir 使用该 NodeObj 本地插入，保证两边 ID 一致。
  const baseAddChild = mind.addChild.bind(mind);
  mind.addChild = async (el, node) => {
    if (node) return baseAddChild(el, node);
    const rootId = currentRootId();
    const parentTpc = el ?? mind.currentNode ?? (rootId ? findTopic(mind, rootId) : null);
    if (!parentTpc) return;
    const parentId = parentTpc.nodeObj.id;
    const created = await createNodeInMind(mind, parentId, null, skipSync);
    if (!created) return;
    await baseAddChild(parentTpc, created.nodeObj);
    const tpc = findTopic(mind, created.id);
    if (tpc) {
      mind.selectNode(tpc);
      void mind.beginEdit(tpc);
      mind.scrollIntoView(tpc);
    }
  };

  const baseInsertSibling = mind.insertSibling.bind(mind);
  mind.insertSibling = async (type, el, node) => {
    if (node) return baseInsertSibling(type, el, node);
    const target = el ?? mind.currentNode;
    if (!target) return;
    const st = useTodoStore.getState();
    const targetId = target.nodeObj.id;
    const pos = siblingInsertPosition(targetId, type, st.nodes, st.childrenOf);
    if (!pos) {
      // 根任务没有兄弟：Enter 等价于新建子任务。
      if (st.nodes[targetId]?.parentId === null) await mind.addChild(target);
      return;
    }
    const created = await createNodeInMind(mind, pos.parentId, pos.position, skipSync);
    if (!created) return;
    await baseInsertSibling(type, target, created.nodeObj);
    const tpc = findTopic(mind, created.id);
    if (tpc) {
      mind.selectNode(tpc);
      void mind.beginEdit(tpc);
      mind.scrollIntoView(tpc);
    }
  };

  // 3) 删除：根任务受保护；其余先 Rust 物理删除，再本地移除。
  const baseRemoveNodes = mind.removeNodes.bind(mind);
  mind.removeNodes = async tpcs => {
    const st = useTodoStore.getState();
    const ids = tpcs.map(t => t.nodeObj.id);
    if (ids.some(id => st.nodes[id]?.parentId === null)) {
      st.showToast('根任务不可删除');
      return;
    }
    const selected = new Set(ids);
    const firstTitle = ids[0] ? st.nodes[ids[0]]?.content ?? '' : '';
    // 选中祖先时，后代会被级联删除，只提交最外层节点。
    const top = tpcs.filter(t => {
      let cur = st.nodes[t.nodeObj.id]?.parentId ?? null;
      while (cur) {
        if (selected.has(cur)) return false;
        cur = st.nodes[cur]?.parentId ?? null;
      }
      return true;
    });
    const patches: TodoAffected[] = [];
    const removedTopics: Topic[] = [];
    for (const t of top) {
      const id = t.nodeObj.id;
      if (!useTodoStore.getState().nodes[id]) continue;
      try {
        patches.push(await ipc.deleteNode(id));
        removedTopics.push(t);
      } catch (e) {
        useTodoStore.getState().showToast(errText(e, '删除失败'));
      }
    }
    if (patches.length === 0) return;
    const merged = mergeAffected(patches);
    skipSync();
    useTodoStore.getState().applyAffected(merged);
    await baseRemoveNodes(removedTopics);
    applyAffectedToMind(mind, merged, onToggle);
    useTodoStore
      .getState()
      .showToast(firstTitle ? `已删除「${firstTitle}」· 撤销` : '已删除 · 撤销', true);
  };

  // 4) 拖拽移动：先 Rust，再本地移动；折叠父节点由 Rust 自动展开。
  const moveMany = async (
    from: Topic[],
    targetId: string,
    mode: 'before' | 'after' | 'in',
  ): Promise<TodoAffected | null> => {
    const st = useTodoStore.getState();
    const pos = dropPosition(targetId, mode, st.nodes, st.childrenOf);
    if (!pos) return null;
    const patches: TodoAffected[] = [];
    for (let i = 0; i < from.length; i += 1) {
      const id = from[i].nodeObj.id;
      if (!useTodoStore.getState().nodes[id]) continue;
      const offset =
        pos.position === null ? null : pos.position + (mode === 'before' ? -i : i) * 1e-3;
      try {
        patches.push(await ipc.moveNode(id, pos.parentId, offset));
      } catch (e) {
        useTodoStore.getState().showToast(errText(e, '移动失败'));
        // 多选拖拽可能只成功了一部分：重新拉取 Rust 快照，避免本地树与数据层分叉。
        if (patches.length > 0) void useTodoStore.getState().loadTree();
        return null;
      }
    }
    return patches.length ? mergeAffected(patches) : null;
  };

  const moveTo = (mode: 'before' | 'after' | 'in') => {
    const base =
      mode === 'before'
        ? mind.moveNodeBefore.bind(mind)
        : mode === 'after'
          ? mind.moveNodeAfter.bind(mind)
          : mind.moveNodeIn.bind(mind);
    return async (from: Topic[], to: Topic) => {
      const af = await moveMany(from, to.nodeObj.id, mode);
      if (!af) return;
      skipSync();
      useTodoStore.getState().applyAffected(af);
      await base(from, to);
      applyAffectedToMind(mind, af, onToggle);
    };
  };

  mind.moveNodeBefore = moveTo('before');
  mind.moveNodeAfter = moveTo('after');
  mind.moveNodeIn = moveTo('in');

  // 5) Alt+↑/↓：Rust 分数定位 + 内置本地移动（保持 Mind Elixir 的动画/选中）。
  const baseMoveUp = mind.moveUpNode.bind(mind);
  mind.moveUpNode = async el => {
    const target = el ?? mind.currentNode;
    if (!target) return;
    const st = useTodoStore.getState();
    const pos = moveAdjacentPosition(target.nodeObj.id, -1, st.nodes, st.childrenOf);
    if (!pos) return;
    try {
      const af = await ipc.moveNode(target.nodeObj.id, pos.parentId, pos.position);
      skipSync();
      useTodoStore.getState().applyAffected(af);
      await baseMoveUp(target);
      applyAffectedToMind(mind, af, onToggle);
    } catch (e) {
      useTodoStore.getState().showToast(errText(e, '移动失败'));
    }
  };

  const baseMoveDown = mind.moveDownNode.bind(mind);
  mind.moveDownNode = async el => {
    const target = el ?? mind.currentNode;
    if (!target) return;
    const st = useTodoStore.getState();
    const pos = moveAdjacentPosition(target.nodeObj.id, 1, st.nodes, st.childrenOf);
    if (!pos) return;
    try {
      const af = await ipc.moveNode(target.nodeObj.id, pos.parentId, pos.position);
      skipSync();
      useTodoStore.getState().applyAffected(af);
      await baseMoveDown(target);
      applyAffectedToMind(mind, af, onToggle);
    } catch (e) {
      useTodoStore.getState().showToast(errText(e, '移动失败'));
    }
  };

  // 6) 不支持的 Mind Elixir 编辑入口：插入父节点 / 复制粘贴不走 Rust，直接禁用，避免第二份数据。
  mind.insertParent = async () => {};
  mind.copyNode = async () => {};
  mind.copyNodes = async () => {};
}

export function MindMapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mindRef = useRef<MindElixir | null>(null);
  const lastSignatureRef = useRef('');
  const skipSyncRef = useRef(false);
  const selectedRef = useRef<string | null>(null);
  /** 当前 mind 实例对应的文档 id（视口读写的归属方）。 */
  const docIdRef = useRef<string | null>(null);
  /** 文档切换时旧树根 id：新数据 refresh 后据此判断「可以按新布局精确恢复视口了」。 */
  const restoreAfterRootRef = useRef<string | null>(null);
  const viewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const nodes = useTodoStore(s => s.nodes);
  const roots = useTodoStore(s => s.roots);
  const childrenOf = useTodoStore(s => s.childrenOf);
  const loaded = useTodoStore(s => s.loaded);
  const selectedId = useTodoStore(s => s.selectedId);
  const currentDocId = useTodoStore(s => s.currentDocId);
  const flashId = useTodoStore(s => s.flashId);
  const revealTarget = useTodoStore(s => s.revealTarget);
  const createRequest = useTodoStore(s => s.createRequest);
  const searchOpen = useTodoStore(s => s.searchOpen);
  const theme = useTodoStore(s => s.theme);
  const hideDone = useTodoStore(s => s.hideDone);

  selectedRef.current = selectedId;

  const skipSync = useCallback(() => {
    skipSyncRef.current = true;
  }, []);

  const onToggle = useCallback((id: string) => {
    const mind = mindRef.current;
    if (mind) void toggleNodeInMind(mind, id);
  }, []);

  /** 立即把当前实例的视口写回所属文档（切文档 / 卸载 / 窗口关闭前调用）。 */
  const flushViewport = useCallback(() => {
    if (viewportTimerRef.current) {
      clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = null;
    }
    const mind = mindRef.current;
    if (!mind) return;
    saveViewport(docIdRef.current, readViewport(mind));
  }, []);

  /** 拖拽 / 缩放很密集，按 250ms 合并写入，避免 localStorage 写放大。 */
  const scheduleViewportSave = useCallback(() => {
    if (viewportTimerRef.current) clearTimeout(viewportTimerRef.current);
    viewportTimerRef.current = setTimeout(() => {
      viewportTimerRef.current = null;
      flushViewport();
    }, 250);
  }, [flushViewport]);

  // 关闭窗口时把最后一次视口落盘（防抖窗口内直接关窗也不会丢）。
  useEffect(() => {
    const onLeave = () => flushViewport();
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [flushViewport]);

  // 初始化：只创建一次 Mind Elixir 实例；后续数据变化由 sync effect 处理。
  useEffect(() => {
    if (!loaded || !containerRef.current || mindRef.current) return;
    const el = containerRef.current;
    const mind = new MindElixir({
      el,
      direction: MindElixir.RIGHT,
      toolBar: false,
      contextMenu: false,
      keypress: true,
      allowUndo: false,
      theme: THEME,
      scaleMin: 0.1,
      scaleMax: 4,
    });
    mindRef.current = mind;
    docIdRef.current = useTodoStore.getState().currentDocId;
    installMindBehavior(mind, skipSync, onToggle);

    mind.bus.addListener('selectNodes', list => {
      const id = list[0]?.id ?? null;
      useTodoStore.getState().select(id);
      // Mind Elixir 选中节点时会把 className 重置成 "selected"，
      // 会抹掉 todo-done / todo-root-topic 等待办视觉；这里立即重新叠加。
      for (const obj of list) {
        const tpc = findTopic(mind, obj.id);
        if (tpc) decorateTopic(tpc, obj, onToggle);
      }
    });
    mind.bus.addListener('scale', scale => {
      useTodoStore.getState().setZoomPercent(Math.round(scale * 100));
      scheduleViewportSave();
    });
    mind.bus.addListener('move', () => {
      scheduleViewportSave();
    });
    mind.bus.addListener('expandNode', node => {
      const st = useTodoStore.getState();
      if (!st.nodes[node.id]) return;
      void ipc
        .setCollapsed(node.id, node.expanded === false)
        .then(af => {
          skipSync();
          st.applyAffected(af);
        })
        .catch(() => {
          // 持久化失败时用 Rust 快照回滚本地展开状态。
          void st.loadTree();
        });
    });
    mind.bus.addListener('operation', op => {
      if (op.name !== 'finishEdit' || !('obj' in op) || !op.obj) return;
      const id = op.obj.id;
      const content = op.obj.topic;
      void (async () => {
        const af = await ipc
          .updateContent(id, content)
          .catch(() => null);
        if (!af) {
          useTodoStore.getState().showToast('保存失败');
          // 保存失败：用 Rust 快照回滚本地节点内容。
          const current = mindRef.current;
          if (current) current.refresh();
          return;
        }
        skipSync();
        useTodoStore.getState().applyAffected(af);
        const current = mindRef.current;
        if (!current) return;
        const selected = selectedRef.current;
        current.refresh();
        if (selected) {
          const tpc = findTopic(current, selected);
          if (tpc) current.selectNode(tpc);
        }
      })();
    });

    setMindMapControls({
      zoomIn: () => mind.scale(mind.scaleVal + 0.1),
      zoomOut: () => mind.scale(mind.scaleVal - 0.1),
      fit: () => mind.scaleFit(),
    });

    const data = buildMindElixirData(nodes, roots, childrenOf, readMindColors(), hideDone);
    if (data) {
      const err = mind.init(data);
      if (err) {
        useTodoStore.getState().showToast(err.message);
      } else {
        lastSignatureRef.current = treeSignature(nodes, roots, hideDone);
        // 恢复该文档上次的视口；没有记录（新文档 / 首次打开）则 100% + 根节点居中。
        applyViewport(mind, loadViewport(docIdRef.current));
      }
    }

    return () => {
      flushViewport();
      setMindMapControls(null);
      mind.destroy();
      mindRef.current = null;
    };
    // 初始化依赖只在首次加载时读取；后续变化由下面的 sync effect 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, skipSync, onToggle]);

  // 切换文档：先把上一个文档的视口存回去，再恢复本文档自己的视口（两个文档互不影响）。
  useEffect(() => {
    const prev = docIdRef.current;
    if (prev === currentDocId) return;
    const mind = mindRef.current;
    docIdRef.current = currentDocId;
    if (!mind) return; // 非树形视图：等重新挂载时由初始化逻辑恢复
    if (prev) saveViewport(prev, readViewport(mind));
    const saved = loadViewport(currentDocId);
    if (prev === null) {
      // 启动竞态（文档索引晚于树数据到达）：此时画布就是当前文档的数据，直接应用。
      applyViewport(mind, saved);
      return;
    }
    // 有历史视口：绝对坐标与布局无关，立即应用可避免一闪。
    // 没有历史视口（新文档）：必须等新数据 refresh 后按新布局居中，先记下当前渲染的根 id。
    if (saved) applyViewport(mind, saved);
    restoreAfterRootRef.current = mind.nodeData?.id ?? '';
  }, [currentDocId]);

  // 一次 store 变更 → 结构变化就全量 refresh，否则只同步状态/内容。
  useEffect(() => {
    const mind = mindRef.current;
    if (!mind) return;
    if (skipSyncRef.current) {
      skipSyncRef.current = false;
      lastSignatureRef.current = treeSignature(nodes, roots, hideDone);
      return;
    }
    const sig = treeSignature(nodes, roots, hideDone);
    if (sig !== lastSignatureRef.current) {
      lastSignatureRef.current = sig;
      const data = buildMindElixirData(nodes, roots, childrenOf, readMindColors(), hideDone);
      if (!data) return;
      const selected = selectedRef.current;
      mind.refresh(data);
      if (selected) {
        const tpc = findTopic(mind, selected);
        if (tpc) mind.selectNode(tpc);
      }
      // 文档切换后的首次 refresh：新树已完成布局，按该文档自己的视口精确定位一次。
      const staleRoot = restoreAfterRootRef.current;
      if (staleRoot !== null && (roots[0] ?? '') !== staleRoot) {
        restoreAfterRootRef.current = null;
        applyViewport(mind, loadViewport(docIdRef.current));
      }
    } else {
      syncNodeMetadata(mind, nodes, onToggle);
    }
  }, [nodes, roots, childrenOf, onToggle, hideDone]);

  // 平铺视图 / 搜索跳转：展开祖先由 store.revealNode 完成，这里只负责选中 + 滚入视口。
  useEffect(() => {
    if (!revealTarget) return;
    const mind = mindRef.current;
    if (!mind) return;
    const tpc = findTopic(mind, revealTarget.id);
    if (!tpc) return;
    mind.selectNode(tpc);
    mind.scrollIntoView(tpc, true);
    useTodoStore.setState({ revealTarget: null });
  }, [revealTarget, nodes]);

  // 外部入口（TopBar “新建任务”）创建请求。
  useEffect(() => {
    if (!createRequest) return;
    const mind = mindRef.current;
    if (!mind) return;
    useTodoStore.getState().clearCreateRequest();
    const parentId = createRequest.parentId ?? currentRootId();
    if (!parentId) return;
    void createChildAndEdit(mind, parentId, createRequest.position, skipSync);
  }, [createRequest]);

  // 搜索跳转 / 新建节点的短暂高亮。
  useEffect(() => {
    if (!flashId) return;
    const mind = mindRef.current;
    if (!mind) return;
    const tpc = findTopic(mind, flashId);
    if (!tpc) return;
    tpc.classList.add('todo-flash');
    const timer = setTimeout(() => tpc.classList.remove('todo-flash'), 1800);
    return () => clearTimeout(timer);
  }, [flashId, nodes]);

  // 主题切换 / 系统主题变化时重算 SVG 连线颜色（Mind Elixir 的 stroke 是属性，不跟随 CSS 变量）。
  useEffect(() => {
    const mind = mindRef.current;
    if (mind) updateBranchColors(mind);
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const mind = mindRef.current;
      if (mind) updateBranchColors(mind);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 树形视图专属快捷键；Tab / Enter / Delete / F2 / 方向键 / Alt+↑↓ / Space 交给 Mind Elixir。
  useEffect(() => {
    if (!loaded) return;
    const onKey = (e: KeyboardEvent) => {
      const st = useTodoStore.getState();
      if (st.viewMode !== 'tree') return;
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true
      ) {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        st.setSearchOpen(true);
        return;
      }
      if (e.shiftKey && e.code === 'Digit1') {
        e.preventDefault();
        mindRef.current?.scaleFit();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'c') {
        const id = st.selectedId;
        if (!id) return;
        e.preventDefault();
        void useRunStore.getState().copyPrompt([id], 'plain');
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'r') {
        const id = st.selectedId;
        if (!id) return;
        e.preventDefault();
        void useRunStore.getState().copyPrompt([id], 'receipt');
        return;
      }
      if (e.altKey && e.key === 'Enter') {
        const id = st.selectedId;
        if (!id) return;
        e.preventDefault();
        const rs = useRunStore.getState();
        rs.openDetail(rs.detailNodeId === id ? null : id);
        return;
      }
      if (mod && (e.key === '.' || e.key === ',')) {
        const id = st.selectedId;
        if (!id) return;
        const mind = mindRef.current;
        if (!mind) return;
        // 根任务在 Mind Elixir 中始终展开，不响应折叠快捷键。
        if (st.nodes[id]?.parentId === null) return;
        const tpc = findTopic(mind, id);
        if (!tpc) return;
        e.preventDefault();
        mind.expandNode(tpc, e.key === ',');
        return;
      }
      if (!mod && !e.altKey && (e.key === 'n' || e.key === 'N')) {
        const rootId = st.roots[0];
        const mind = mindRef.current;
        if (!rootId || !mind) return;
        e.preventDefault();
        void createChildAndEdit(mind, rootId, null, skipSync);
        return;
      }
      if (!mod && !e.altKey && (e.key === 's' || e.key === 'S')) {
        const id = st.selectedId;
        if (!id) return;
        e.preventDefault();
        void onToggle(id);
        return;
      }
      if (e.key === 'Escape') {
        st.setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loaded, onToggle, skipSync]);

  // 运行中节点每秒刷新徽标文字（全局只用一个 interval，docs/06 §9.4）。
  useEffect(() => {
    const t = setInterval(() => {
      const st = useTodoStore.getState();
      const root = containerRef.current;
      if (!root) return;
      root.querySelectorAll<HTMLElement>('me-tpc[data-nodeid]').forEach(tpc => {
        const id = nodeIdFromEl(tpc);
        const badge = tpc.querySelector<HTMLElement>('.exec-badge');
        if (!id || !badge) return;
        const exec = st.nodes[id]?.execution ?? null;
        badge.textContent = execLabel(exec, Date.now());
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const onContextMenu = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest('me-tpc[data-nodeid]');
    const id = nodeIdFromEl(el);
    if (!id) return;
    e.preventDefault();
    const st = useTodoStore.getState();
    if (st.selectedId !== id) st.select(id);
    setMenu({ x: e.clientX, y: e.clientY, nodeId: id });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    downRef.current = { x: e.clientX, y: e.clientY };
  };

  const onMouseUp = (e: React.MouseEvent) => {
    const down = downRef.current;
    downRef.current = null;
    if (!down || e.button !== 0) return;
    const moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y);
    const target = e.target as HTMLElement;

    // 右键菜单内部的点击必须原样交给菜单按钮 —— 否则这里先 setMenu(null)
    // 把按钮卸载掉，click 事件就落空了（「查看详情 / 派发」点了没反应的根因）。
    if (target.closest('[data-context-menu]')) return;

    const badge = target.closest('.exec-badge') as HTMLElement | null;
    if (badge) {
      const id = nodeIdFromEl(badge.closest('me-tpc[data-nodeid]'));
      if (id) {
        const exec = useTodoStore.getState().nodes[id]?.execution;
        if (exec?.runId) useRunStore.getState().openRun(exec.runId);
        else useRunStore.getState().openDetail(id);
      }
      return;
    }
    if (moved < 4 && !target.closest('me-tpc')) {
      useRunStore.getState().openDetail(null);
      setMenu(null);
    }
  };

  return (
    <div className="absolute inset-0" onContextMenu={onContextMenu} onMouseDown={onMouseDown} onMouseUp={onMouseUp}>
      {/* Mind Elixir 会把传入元素设为 position:relative，因此这里用 h-full/w-full 填充外层定位容器。 */}
      <div ref={containerRef} className="mind-map-container h-full w-full" />
      <SearchBar open={searchOpen} onClose={() => useTodoStore.getState().setSearchOpen(false)} />
      <NodeContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

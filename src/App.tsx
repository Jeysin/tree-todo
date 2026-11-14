import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';

import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { ToastContainer } from './components/Toast';
import { TopBar } from './components/TopBar';
import { NodeDetailPanel } from './components/NodeDetailPanel';
import { RunDrawer } from './components/RunDrawer';
import { UpdateDialog } from './components/UpdateDialog';
import { useOverviewStore } from './stores/overviewStore';
import { initRunEvents, useRunStore } from './stores/runStore';
import { useTodoStore } from './stores/todoStore';
import { useUpdateStore } from './stores/updateStore';
import { FlatView } from './views/flat/FlatView';
import { OverviewView } from './views/overview/OverviewView';
import { SettingsView } from './views/settings/SettingsView';
import { StatsView } from './views/stats/StatsView';
import { TrashView } from './views/trash/TrashView';
import { MindMapView } from './views/tree/MindMapView';

function App() {
  const viewMode = useTodoStore(s => s.viewMode);
  const loaded = useTodoStore(s => s.loaded);
  const loadTree = useTodoStore(s => s.loadTree);
  const loadDocuments = useTodoStore(s => s.loadDocuments);
  const loadTrash = useTodoStore(s => s.loadTrash);
  const refreshClipboard = useTodoStore(s => s.refreshClipboard);
  const setViewMode = useTodoStore(s => s.setViewMode);
  const undo = useTodoStore(s => s.undo);
  const redo = useTodoStore(s => s.redo);

  // 启动：文档列表 + 当前文档数据 + 回收站徽标 + 剪贴板可用态
  useEffect(() => {
    void loadDocuments();
    void loadTree();
    void loadTrash();
    void refreshClipboard();
    void useOverviewStore.getState().refreshToday();
  }, [loadDocuments, loadTree, loadTrash, refreshClipboard]);

  // 侧栏「今日完成」徽标：启动对账可能稍晚完成，30s 轮询兜底；跨零点也会自动归零。
  useEffect(() => {
    const timer = window.setInterval(() => {
      void useOverviewStore.getState().refreshToday();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // 运行事件监听（只注册一次；run:status 由 MCP 回执 / 验收 / 收口推送）
  useEffect(() => {
    void useRunStore.getState().loadRuns();
    const off = initRunEvents();
    return off;
  }, []);

  // 系统菜单栏 File → 导出全部 / 导入（Rust 侧发事件，这里复用前端 dialog + 命令）
  useEffect(() => {
    const pending = [
      listen('menu:export-all', () => void useTodoStore.getState().exportAll()),
      listen('menu:import', () => void useTodoStore.getState().importBundle(null)),
      listen('menu:check-update', () => void useUpdateStore.getState().check({ manual: true })),
    ].map(p => p.catch(() => () => {}));
    return () => {
      for (const p of pending) void p.then(unlisten => unlisten());
    };
  }, []);

  // 启动自动检查更新（docs/08 §6.5）：每次启动一次；失败静默；正在编辑节点时延后弹窗。
  useEffect(() => {
    if (!loaded || !import.meta.env.PROD) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const run = () => {
      const el = document.activeElement as HTMLElement | null;
      const editing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (editing && attempts < 6) {
        attempts += 1;
        timer = setTimeout(run, 15000);
        return;
      }
      void useUpdateStore.getState().check({ manual: false });
    };
    timer = setTimeout(run, 3000);
    return () => clearTimeout(timer);
  }, [loaded]);

  // 全局快捷键：Ctrl/Cmd + 1/2/3 切换视图；Ctrl/Cmd + Z 撤销、Shift+Z / Y 重做
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === '1') {
        e.preventDefault();
        setViewMode('tree');
      } else if (key === '2') {
        e.preventDefault();
        setViewMode('flat');
      } else if (key === '3') {
        e.preventDefault();
        setViewMode('stats');
      } else if (key === '4') {
        e.preventDefault();
        setViewMode('overview');
      } else if (key === ',') {
        e.preventDefault();
        setViewMode('settings');
      } else if (key === 'z' && !isEditable) {
        e.preventDefault();
        if (e.shiftKey) void redo();
        else void undo();
      } else if (key === 'y' && !isEditable) {
        e.preventDefault();
        void redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setViewMode, undo, redo]);

  // 节点复制 / 粘贴：capture 阶段接管 Cmd/Ctrl+C/V。
  // Mind Elixir 自带 clipboard 事件（把节点序列化进系统剪贴板并本地 copyNodes 插入），
  // 会在 Rust 之外产生第二份数据；这里在 keydown 阶段就截断，只走 Rust 剪贴板。
  // 输入框 / contenteditable 放行原生复制粘贴；Shift+C/R 属于「复制 Prompt」，不拦截。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== 'c' && key !== 'v') return;
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true
      ) {
        return;
      }
      const st = useTodoStore.getState();
      if (st.viewMode !== 'tree') return;
      e.preventDefault();
      e.stopPropagation();
      if (key === 'c') {
        const ids =
          st.selectedIds.length > 0 ? st.selectedIds : st.selectedId ? [st.selectedId] : [];
        void st.copyNodes(ids);
      } else {
        if (!st.selectedId) {
          st.showToast('请先选中要粘贴到的节点');
          return;
        }
        void st.pasteNodes(st.selectedId);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!loaded) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted">加载中…</div>
    );
  }

  return (
    <>
      <div className="flex h-full">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar />
          <main className="relative flex-1 min-h-0">
            {viewMode === 'tree' && <MindMapView />}
            {viewMode === 'flat' && <FlatView />}
            {viewMode === 'stats' && <StatsView />}
            {viewMode === 'overview' && <OverviewView />}
            {viewMode === 'trash' && <TrashView />}
            {viewMode === 'settings' && <SettingsView />}
            {viewMode !== 'settings' && viewMode !== 'overview' && <NodeDetailPanel />}
            {viewMode !== 'settings' && viewMode !== 'overview' && <RunDrawer />}
          </main>
          <StatusBar />
        </div>
      </div>
      <ToastContainer />
      <UpdateDialog />
    </>
  );
}

export default App;

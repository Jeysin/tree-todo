import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';

import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { ToastContainer } from './components/Toast';
import { TopBar } from './components/TopBar';
import { NodeDetailPanel } from './components/NodeDetailPanel';
import { RunDrawer } from './components/RunDrawer';
import { UpdateDialog } from './components/UpdateDialog';
import { initRunEvents, useRunStore } from './stores/runStore';
import { useTodoStore } from './stores/todoStore';
import { useUpdateStore } from './stores/updateStore';
import { FlatView } from './views/flat/FlatView';
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
  const setViewMode = useTodoStore(s => s.setViewMode);
  const undo = useTodoStore(s => s.undo);
  const redo = useTodoStore(s => s.redo);

  // 启动：文档列表 + 当前文档数据 + 回收站徽标
  useEffect(() => {
    void loadDocuments();
    void loadTree();
    void loadTrash();
  }, [loadDocuments, loadTree, loadTrash]);

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
            {viewMode === 'trash' && <TrashView />}
            {viewMode === 'settings' && <SettingsView />}
            {viewMode !== 'settings' && <NodeDetailPanel />}
            {viewMode !== 'settings' && <RunDrawer />}
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

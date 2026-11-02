import { useEffect } from 'react';

import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { ToastContainer } from './components/Toast';
import { TopBar } from './components/TopBar';
import { useTodoStore } from './stores/todoStore';
import { FlatView } from './views/flat/FlatView';
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
          </main>
          <StatusBar />
        </div>
      </div>
      <ToastContainer />
    </>
  );
}

export default App;

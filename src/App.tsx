import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';

import { StatusBar } from './components/StatusBar';
import { ToastContainer } from './components/Toast';
import { TopBar } from './components/TopBar';
import { useTodoStore } from './stores/todoStore';
import { FlatView } from './views/flat/FlatView';
import { TreeView } from './views/tree/TreeView';

function App() {
  const viewMode = useTodoStore(s => s.viewMode);
  const loaded = useTodoStore(s => s.loaded);
  const loadTree = useTodoStore(s => s.loadTree);
  const setViewMode = useTodoStore(s => s.setViewMode);
  const undo = useTodoStore(s => s.undo);
  const redo = useTodoStore(s => s.redo);

  // 启动：一次性加载全量树
  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  // 全局快捷键：Ctrl/Cmd + 1/2 切视图；Ctrl/Cmd + Z 撤销、Shift+Z / Y 重做
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA';
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === '1') {
        e.preventDefault();
        setViewMode('tree');
      } else if (key === '2') {
        e.preventDefault();
        setViewMode('flat');
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
    <ReactFlowProvider>
      <div className="flex flex-col h-full">
        <TopBar />
        <main className="relative flex-1 min-h-0">
          {viewMode === 'tree' ? <TreeView /> : <FlatView />}
        </main>
        <StatusBar />
      </div>
      <ToastContainer />
    </ReactFlowProvider>
  );
}

export default App;

import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';

import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import { useTodoStore } from './stores/todoStore';
import { FlatView } from './views/flat/FlatView';
import { TreeView } from './views/tree/TreeView';

function App() {
  const viewMode = useTodoStore(s => s.viewMode);
  const loaded = useTodoStore(s => s.loaded);
  const loadTree = useTodoStore(s => s.loadTree);
  const setViewMode = useTodoStore(s => s.setViewMode);

  // 启动：一次性加载全量树
  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  // Ctrl/Cmd + 1/2 切换视图（docs/04 §5）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '1') {
          e.preventDefault();
          setViewMode('tree');
        } else if (e.key === '2') {
          e.preventDefault();
          setViewMode('flat');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setViewMode]);

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
    </ReactFlowProvider>
  );
}

export default App;

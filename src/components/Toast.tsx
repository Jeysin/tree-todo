/** 底部 toast（v0.2：静默删除 + 撤销、导入导出结果提示）。 */
import { useEffect } from 'react';
import { X } from 'lucide-react';

import { useTodoStore } from '../stores/todoStore';

export function ToastContainer() {
  const toast = useTodoStore(s => s.toast);
  const clearToast = useTodoStore(s => s.clearToast);
  const undo = useTodoStore(s => s.undo);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clearToast, 5000);
    return () => clearTimeout(t);
  }, [toast, clearToast]);

  if (!toast) return null;
  return (
    <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 rounded-lg bg-elevated border border-border shadow-xl text-sm whitespace-nowrap">
      <span className="text-primary">{toast.message}</span>
      {toast.undoable && (
        <button
          onClick={() => {
            clearToast();
            void undo();
          }}
          className="text-accent font-medium hover:underline"
        >
          撤销
        </button>
      )}
      <button
        onClick={clearToast}
        className="text-muted hover:text-primary transition-colors"
        title="关闭"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/** 回收站视图（docs/05 M3）：恢复 / 彻底删除 / 清空。 */
import { useEffect } from 'react';
import { ArrowLeft, RotateCcw, Trash2 } from 'lucide-react';

import { formatDoneTime } from '../../lib/time';
import { useTodoStore } from '../../stores/todoStore';

export function TrashView() {
  const trash = useTodoStore(s => s.trash);
  const loadTrash = useTodoStore(s => s.loadTrash);
  const restoreTrash = useTodoStore(s => s.restoreTrash);
  const purgeTrash = useTodoStore(s => s.purgeTrash);
  const emptyTrash = useTodoStore(s => s.emptyTrash);
  const setViewMode = useTodoStore(s => s.setViewMode);

  useEffect(() => {
    void loadTrash();
  }, [loadTrash]);

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="max-w-3xl mx-auto py-6 px-4">
        <header className="flex items-start justify-between gap-3 mb-5">
          <div>
            <h1 className="text-lg font-semibold text-primary">回收站</h1>
            <p className="text-xs text-muted mt-1">
              删除的节点保留在这里，可随时恢复；「彻底删除」后不可恢复
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setViewMode('tree')}
              className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-border text-[13px] text-primary hover:bg-base transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              返回
            </button>
            {trash.length > 0 && (
              <button
                onClick={() => void emptyTrash()}
                className="px-3 h-8 rounded-lg bg-red-500/90 text-white text-[13px] hover:bg-red-500 transition-colors"
              >
                清空回收站
              </button>
            )}
          </div>
        </header>

        {trash.length === 0 ? (
          <div className="py-20 text-center">
            <Trash2 className="w-10 h-10 mx-auto text-muted/40 mb-3" />
            <p className="text-sm text-muted">回收站是空的</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {trash.map(item => (
              <div
                key={item.node.id}
                className="group flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-primary truncate">
                    {item.node.content || '未命名'}
                    {item.descendantCount > 0 && (
                      <span className="ml-2 text-xs text-muted">
                        含 {item.descendantCount} 个子节点
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted/70 mt-0.5">
                    删除于 {formatDoneTime(item.node.deletedAt ?? item.node.updatedAt)}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => void restoreTrash(item.node.id)}
                    className="flex items-center gap-1 px-2.5 h-7 rounded-md border border-border text-xs text-primary hover:bg-base transition-colors"
                    title="恢复到原位置"
                  >
                    <RotateCcw className="w-3 h-3" />
                    恢复
                  </button>
                  <button
                    onClick={() => void purgeTrash(item.node.id)}
                    className="flex items-center gap-1 px-2.5 h-7 rounded-md text-xs text-red-500 hover:bg-red-500/10 transition-colors"
                    title="彻底删除（不可恢复）"
                  >
                    <Trash2 className="w-3 h-3" />
                    彻底删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

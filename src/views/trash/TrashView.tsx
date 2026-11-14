/** 回收站视图（v0.6）：回收对象是文档或整个目录；目录恢复时结构与文档一起还原。 */
import { useEffect } from 'react';
import { ArrowLeft, FileText, Folder, RotateCcw, Trash2 } from 'lucide-react';

import { formatDoneTime } from '../../lib/time';
import { useT } from '../../i18n';
import { useTodoStore } from '../../stores/todoStore';

export function TrashView() {
  const t = useT();
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
            <h1 className="text-lg font-semibold text-primary">{t('回收站')}</h1>
            <p className="text-xs text-muted mt-1">
              {t('删除的文档或目录保留在这里，可随时整体恢复；「彻底删除」后数据不可恢复')}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setViewMode('tree')}
              className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-border text-[13px] text-primary hover:bg-base transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {t('返回')}
            </button>
            {trash.length > 0 && (
              <button
                onClick={() => void emptyTrash()}
                className="px-3 h-8 rounded-lg bg-red-500/90 text-white text-[13px] hover:bg-red-500 transition-colors"
              >
                {t('清空回收站')}
              </button>
            )}
          </div>
        </header>

        {trash.length === 0 ? (
          <div className="py-20 text-center">
            <Trash2 className="w-10 h-10 mx-auto text-muted/40 mb-3" />
            <p className="text-sm text-muted">{t('回收站是空的')}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {trash.map(item => {
              const isFolder = item.kind === 'folder';
              return (
                <div
                  key={item.id}
                  className="group flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3"
                >
                  {isFolder ? (
                    <Folder className="w-4 h-4 shrink-0 text-accent/80" />
                  ) : (
                    <FileText className="w-4 h-4 shrink-0 text-muted" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-primary truncate">
                      {item.name || (isFolder ? t('未命名目录') : t('未命名文档'))}
                    </div>
                    <div className="text-xs text-muted/70 mt-0.5">
                      {t('删除于 {time}', { time: formatDoneTime(item.deletedAt) })}
                      {isFolder && (
                        <>
                          <span className="mx-1">·</span>
                          {t('{n} 个文档', { n: item.documentCount })}
                          {item.folderCount > 0 && (
                            <span> · {t('{n} 个子目录', { n: item.folderCount })}</span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => void restoreTrash(item.id)}
                      className="flex items-center gap-1 px-2.5 h-7 rounded-md border border-border text-xs text-primary hover:bg-base transition-colors"
                      title={isFolder ? t('恢复目录（含其中的文档）') : t('恢复文档到侧边栏')}
                    >
                      <RotateCcw className="w-3 h-3" />
                      {t('恢复')}
                    </button>
                    <button
                      onClick={() => void purgeTrash(item.id)}
                      className="flex items-center gap-1 px-2.5 h-7 rounded-md text-xs text-red-500 hover:bg-red-500/10 transition-colors"
                      title={
                        isFolder
                          ? t('彻底删除目录（含其中的文档，不可恢复）')
                          : t('彻底删除文档（不可恢复）')
                      }
                    >
                      <Trash2 className="w-3 h-3" />
                      {t('彻底删除')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

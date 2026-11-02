/** 左侧文档边栏（docs/05 M3 多文档）：文档切换 / 新建 / 双击重命名 / 移入回收站，底部回收站入口。 */
import { useState } from 'react';
import { FileText, Plus, Trash2 } from 'lucide-react';

import { AppIcon } from './AppIcon';
import { useTodoStore } from '../stores/todoStore';

export function Sidebar() {
  const documents = useTodoStore(s => s.documents);
  const currentDocId = useTodoStore(s => s.currentDocId);
  const viewMode = useTodoStore(s => s.viewMode);
  const switchDocument = useTodoStore(s => s.switchDocument);
  const createDocument = useTodoStore(s => s.createDocument);
  const renameDocument = useTodoStore(s => s.renameDocument);
  const deleteDocument = useTodoStore(s => s.deleteDocument);
  const setViewMode = useTodoStore(s => s.setViewMode);
  const trash = useTodoStore(s => s.trash);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const commitRename = (id: string) => {
    const name = draftName.trim();
    setEditingId(null);
    const cur = documents.find(d => d.id === id);
    if (name && cur && name !== cur.name) void renameDocument(id, name);
  };

  return (
    <aside className="w-[218px] shrink-0 flex flex-col bg-surface border-r border-border">
      <div className="flex items-center gap-2 px-3.5 h-12 border-b border-border shrink-0">
        <AppIcon size={22} />
        <span className="text-[15px] font-semibold tracking-tight text-primary select-none">
          tree-todo
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-2.5 px-2">
        <div className="flex items-center justify-between px-2 pb-1.5">
          <span className="text-[11px] font-medium text-muted uppercase tracking-wider select-none">
            文档
          </span>
          <button
            onClick={() => void createDocument('新文档')}
            className="w-5 h-5 rounded flex items-center justify-center text-muted hover:text-primary hover:bg-base transition-colors"
            title="新建文档"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {documents.map(d => {
          const active = d.id === currentDocId;
          return (
            <div
              key={d.id}
              onClick={() => !active && void switchDocument(d.id)}
              onDoubleClick={() => {
                setEditingId(d.id);
                setDraftName(d.name);
              }}
              className={[
                'group flex items-center gap-1.5 px-2 h-7 rounded-md cursor-pointer text-[13px] transition-colors',
                active
                  ? 'bg-accent/12 text-primary font-medium'
                  : 'text-muted hover:bg-base hover:text-primary',
              ].join(' ')}
              title={active ? `${d.name}（双击重命名）` : d.name}
            >
              <FileText className={['w-3.5 h-3.5 shrink-0', active ? 'text-accent' : ''].join(' ')} />
              {editingId === d.id ? (
                <input
                  autoFocus
                  value={draftName}
                  onChange={e => setDraftName(e.target.value)}
                  onBlur={() => commitRename(d.id)}
                  onKeyDown={e => {
                    e.stopPropagation();
                    if (e.key === 'Enter') commitRename(d.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  className="flex-1 min-w-0 bg-transparent outline-none text-primary border-b border-accent/60"
                />
              ) : (
                <span className="flex-1 truncate">{d.name}</span>
              )}
              {documents.length > 1 && editingId !== d.id && (
                <button
                  onClick={e => {
                    e.stopPropagation();
                    void deleteDocument(d.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 w-5 h-5 rounded flex items-center justify-center text-muted hover:text-red-500 transition-all"
                  title="删除文档"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-border p-2 shrink-0">
        <button
          onClick={() => setViewMode('trash')}
          className={[
            'w-full flex items-center gap-2 px-2 h-8 rounded-md text-[13px] transition-colors',
            viewMode === 'trash'
              ? 'bg-accent/12 text-primary font-medium'
              : 'text-muted hover:bg-base hover:text-primary',
          ].join(' ')}
        >
          <Trash2 className="w-3.5 h-3.5" />
          回收站
          {trash.length > 0 && (
            <span className="ml-auto px-1.5 py-0.5 rounded-full bg-accent/15 text-accent text-[10px] leading-3">
              {trash.length}
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}

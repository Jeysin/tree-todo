import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ClipboardCheck, Loader2, Square, X, XCircle } from 'lucide-react';

import { ipc } from '../ipc';
import { formatDuration, liveDuration } from '../lib/exec';
import { useRunStore } from '../stores/runStore';
import { breadcrumb, useTodoStore } from '../stores/todoStore';

const STATE_TEXT: Record<string, string> = {
  queued: '排队中（旧数据）',
  running: '执行中',
  awaiting_review: '待验收',
  failed: '执行失败',
};

export function NodeDetailPanel() {
  const nodeId = useRunStore(s => s.detailNodeId);
  const close = useRunStore(s => s.openDetail);
  const accept = useRunStore(s => s.accept);
  const acceptNode = useRunStore(s => s.acceptNode);
  const reject = useRunStore(s => s.reject);
  const closeRun = useRunStore(s => s.closeRun);
  const copyPrompt = useRunStore(s => s.copyPrompt);
  const dismissNode = useRunStore(s => s.dismissNode);
  const openRun = useRunStore(s => s.openRun);

  const nodes = useTodoStore(s => s.nodes);
  const node = nodeId ? nodes[nodeId] : undefined;
  const path = useMemo(() => (nodeId ? breadcrumb({ nodes }, nodeId) : []), [nodeId, nodes]);
  const [note, setNote] = useState('');
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [now, setNow] = useState(Date.now());
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!node) return;
    if (loadedFor.current !== node.id) {
      loadedFor.current = node.id;
      setNote(node.note);
      setShowFeedback(false);
      setFeedback('');
    }
  }, [node]);

  useEffect(() => {
    if (!node) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [node]);

  // note 防抖自动保存
  useEffect(() => {
    if (!node || note === node.note) return;
    const t = setTimeout(() => {
      void ipc
        .updateNote(node.id, note)
        .then(af => {
          useTodoStore.getState().applyAffected(af);
        })
        .catch(e => useTodoStore.getState().showToast((e as { message?: string })?.message ?? '保存失败'));
    }, 600);
    return () => clearTimeout(t);
  }, [note, node]);

  if (!node) return null;
  const exec = node.execution ?? null;
  const duration = exec ? liveDuration(exec, now) : undefined;

  return (
    <aside className="absolute right-0 top-0 bottom-0 w-[380px] z-30 border-l border-border bg-surface shadow-2xl flex flex-col">
      <header className="flex items-start gap-2 px-4 py-3 border-b border-border shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-primary break-words">{node.content || '未命名'}</div>
          {path.length > 0 && <div className="text-[11px] text-muted truncate mt-0.5">{path.join(' / ')}</div>}
        </div>
        <button
          onClick={() => close(null)}
          className="w-7 h-7 rounded flex items-center justify-center text-muted hover:bg-base"
          title="关闭（Esc）"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <section className="px-4 py-3 border-b border-border">
          <div className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2">执行</div>
          {!exec ? (
            <div className="text-xs text-muted/80 leading-5">
              未执行。右键「复制 Prompt（带回执）」粘贴给你的 AI Agent，Agent 开始执行后这里会亮起。
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span
                  className={[
                    'w-2 h-2 rounded-full',
                    exec.state === 'running'
                      ? 'bg-accent animate-pulse'
                      : exec.state === 'awaiting_review'
                        ? 'bg-warning'
                        : exec.state === 'failed'
                          ? 'bg-red-500'
                          : 'bg-muted',
                  ].join(' ')}
                />
                <span className="text-sm text-primary">{STATE_TEXT[exec.state] ?? exec.state}</span>
                {exec.needsConfirmation && (
                  <span className="text-[11px] text-warning">· 未收到回执</span>
                )}
                <span className="ml-auto text-xs text-muted tabular-nums">{formatDuration(duration)}</span>
              </div>
              <dl className="grid grid-cols-[64px_1fr] gap-y-1 text-xs">
                <dt className="text-muted">Agent</dt>
                <dd className="text-primary truncate">{exec.agentName || '—'}</dd>
                {exec.startedAt && (
                  <>
                    <dt className="text-muted">开始</dt>
                    <dd className="text-primary tabular-nums">{new Date(exec.startedAt).toLocaleTimeString()}</dd>
                  </>
                )}
                {exec.reported && (
                  <>
                    <dt className="text-muted">回执</dt>
                    <dd className="text-primary">{exec.reported === 'done' ? '已完成' : exec.reported}</dd>
                  </>
                )}
              </dl>
              {exec.summary && <p className="text-xs text-muted leading-5 line-clamp-3">{exec.summary}</p>}

              <div className="flex flex-wrap gap-2 pt-1">
                {exec.state === 'running' && exec.runId && (
                  <>
                    <button
                      onClick={() => void closeRun(exec.runId!)}
                      className="h-7 px-2.5 rounded border border-border text-xs text-muted hover:text-red-500 inline-flex items-center gap-1"
                    >
                      <Square className="w-3 h-3" /> 标记结束
                    </button>
                    <span className="text-[11px] text-muted/70 self-center">
                      Agent 未回报完成时计时不会自动停止，可手动收口
                    </span>
                  </>
                )}
                {exec.state === 'awaiting_review' && (
                  <>
                    <button
                      onClick={() => (exec.runId ? void accept(exec.runId, [node.id]) : void acceptNode(node.id))}
                      className="h-7 px-2.5 rounded bg-success text-white text-xs inline-flex items-center gap-1"
                    >
                      <Check className="w-3 h-3" /> 通过并完成
                    </button>
                    <button
                      onClick={() => setShowFeedback(v => !v)}
                      className="h-7 px-2.5 rounded border border-border text-xs text-primary hover:bg-base inline-flex items-center gap-1"
                    >
                      <XCircle className="w-3 h-3" /> 驳回
                    </button>
                    {exec.runId && (
                      <button
                        onClick={() => openRun(exec.runId!)}
                        className="h-7 px-2.5 rounded border border-border text-xs text-muted hover:text-primary"
                      >
                        执行详情
                      </button>
                    )}
                  </>
                )}
                {exec.state === 'failed' && (
                  <>
                    <button
                      onClick={() => void copyPrompt([node.id], 'receipt')}
                      className="h-7 px-2.5 rounded border border-border text-xs text-primary hover:bg-base inline-flex items-center gap-1"
                    >
                      <ClipboardCheck className="w-3 h-3" /> 重新复制（带回执）
                    </button>
                    <button
                      onClick={() => void dismissNode(node.id)}
                      className="h-7 px-2.5 rounded border border-border text-xs text-muted hover:text-primary"
                    >
                      忽略
                    </button>
                  </>
                )}
                {exec.state === 'queued' && (
                  <span className="text-[11px] text-muted inline-flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> 等待中
                  </span>
                )}
              </div>

              {showFeedback && (
                <div className="pt-1 space-y-1.5">
                  <textarea
                    value={feedback}
                    onChange={e => setFeedback(e.target.value)}
                    placeholder="驳回原因（会写回节点备注）"
                    className="w-full h-20 px-2 py-1.5 rounded border border-border bg-base text-xs outline-none focus:border-accent resize-none"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        if (!exec.runId) return;
                        void reject(exec.runId, [node.id], feedback);
                        setShowFeedback(false);
                      }}
                      className="h-7 px-2.5 rounded bg-red-500 text-white text-xs"
                    >
                      确认驳回
                    </button>
                    <button
                      onClick={() => setShowFeedback(false)}
                      className="h-7 px-2.5 rounded border border-border text-xs text-muted"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="px-4 py-3">
          <div className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2">补充说明</div>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="补充说明（可选）——标题已经足够清楚时不必填"
            className="w-full h-40 px-2.5 py-2 rounded-md border border-border bg-base text-xs leading-5 outline-none focus:border-accent resize-none"
          />
          <div className="text-[11px] text-muted/60 mt-1">自动保存 · 会随标题一起组装进 Prompt</div>
        </section>
      </div>

      <footer className="px-4 py-2.5 border-t border-border text-[11px] text-muted shrink-0 flex items-center gap-1.5">
        <ClipboardCheck className="w-3 h-3" />
        {exec?.agentName ? `上次执行：${exec.agentName}` : '右键复制 Prompt，粘贴给你的 AI Agent'}
      </footer>
    </aside>
  );
}

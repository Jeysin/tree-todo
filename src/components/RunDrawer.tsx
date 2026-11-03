import { useEffect, useState } from 'react';
import { Check, Square, X, XCircle } from 'lucide-react';

import { ipc } from '../ipc';
import type { RunView } from '../ipc/types';
import { formatDuration } from '../lib/exec';
import { useRunStore } from '../stores/runStore';

/** run 状态文案（docs/06 v2 §6.1）。 */
const STATUS_TEXT: Record<string, string> = {
  dispatched: '已复制，等待 Agent 开始',
  queued: '排队中（旧数据）',
  running: '执行中',
  awaiting_review: '待验收',
  reviewed: '已收口',
  failed: '失败',
  blocked: '被阻塞（旧数据）',
  cancelled: '已取消',
  interrupted: '已中断（旧数据）',
};

/** 执行详情面板（docs/06 v2 §9：无进程日志，展示回执与验收）。
 *  v1 的实时日志区 / 中断按钮随 push 方向移除；running 卡死用「标记结束」收口（D33）。 */
export function RunDrawer() {
  const runId = useRunStore(s => s.activeRunId);
  const close = useRunStore(s => s.openRun);
  const runs = useRunStore(s => s.runs);
  const closeRun = useRunStore(s => s.closeRun);
  const accept = useRunStore(s => s.accept);
  const reject = useRunStore(s => s.reject);
  const [run, setRun] = useState<RunView | null>(null);
  const [feedback, setFeedback] = useState('');
  const [showReject, setShowReject] = useState(false);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      return;
    }
    const fromList = runs.find(r => r.id === runId);
    if (fromList) setRun(fromList);
    else void ipc.getRun(runId).then(setRun).catch(() => setRun(null));
  }, [runId, runs]);

  if (!runId) return null;
  const pending = run?.nodes.filter(n => n.review === 'pending') ?? [];
  const isRunning = run?.status === 'running';

  return (
    <aside className="absolute right-0 top-0 bottom-0 w-[440px] z-40 border-l border-border bg-surface shadow-2xl flex flex-col">
      <header className="flex items-center gap-2 px-4 h-12 border-b border-border shrink-0">
        <span className="text-sm font-medium text-primary">执行</span>
        <span className="text-[11px] text-muted truncate">{run?.agentId}</span>
        <span className="ml-auto text-[11px] text-muted tabular-nums">
          {run ? formatDuration(run.durationMs) : ''}
        </span>
        <button
          onClick={() => close(null)}
          className="w-7 h-7 rounded flex items-center justify-center text-muted hover:bg-base"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="px-4 py-2 border-b border-border text-xs flex items-center gap-2 shrink-0">
        <span
          className={[
            'w-2 h-2 rounded-full',
            isRunning
              ? 'bg-accent animate-pulse'
              : run?.status === 'awaiting_review'
                ? 'bg-warning'
                : run?.status === 'failed'
                  ? 'bg-red-500'
                  : 'bg-muted',
          ].join(' ')}
        />
        <span className="text-primary">{STATUS_TEXT[run?.status ?? ''] ?? run?.status ?? '加载中'}</span>
        {run?.summary && (
          <span className="text-muted truncate" title={run.summary}>
            {run.summary}
          </span>
        )}
        {run?.error && <span className="text-red-500 truncate" title={run.error}>{run.error}</span>}
      </div>

      {run && run.nodes.length > 0 && (
        <div className="px-4 py-2 border-b border-border max-h-56 overflow-y-auto shrink-0">
          <div className="text-[11px] text-muted mb-1">任务回执</div>
          <ul className="space-y-1">
            {run.nodes.map(n => (
              <li key={n.nodeId} className="flex items-center gap-2 text-xs">
                <span
                  className={[
                    'w-1.5 h-1.5 rounded-full',
                    n.report === 'done' ? 'bg-success' : n.report === 'failed' ? 'bg-red-500' : 'bg-muted',
                  ].join(' ')}
                />
                <span className="truncate text-primary flex-1">{n.content || n.nodeId}</span>
                <span className="text-muted">
                  {n.review === 'accepted'
                    ? '已验收'
                    : n.review === 'rejected'
                      ? '已驳回'
                      : n.review === 'dismissed'
                        ? '已忽略'
                        : n.report}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-xs text-muted/80 leading-6">
        {run?.prompt ? (
          <details>
            <summary className="cursor-pointer select-none text-muted">Prompt 快照（复制时的内容）</summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-muted/70">{run.prompt}</pre>
          </details>
        ) : (
          <div>此面板展示回执与验收操作；执行过程由 Agent 通过 MCP 工具回报。</div>
        )}
      </div>

      <footer className="border-t border-border p-3 space-y-2 shrink-0">
        {isRunning && (
          <div className="space-y-1.5">
            <div className="text-[11px] text-muted/70">
              计时会一直走下去；若 Agent 已停止工作但未回报完成，可手动收口。
            </div>
            <button
              onClick={() => void closeRun(runId)}
              className="h-8 px-3 rounded-md border border-border text-xs text-muted hover:text-red-500 inline-flex items-center gap-1"
            >
              <Square className="w-3.5 h-3.5" /> 标记结束
            </button>
          </div>
        )}
        {run?.status === 'awaiting_review' && pending.length > 0 && (
          <div className="flex gap-2">
            <button
              onClick={() => void accept(runId, pending.map(n => n.nodeId))}
              className="h-8 px-3 rounded-md bg-success text-white text-xs inline-flex items-center gap-1"
            >
              <Check className="w-3.5 h-3.5" /> 全部通过
            </button>
            <button
              onClick={() => setShowReject(v => !v)}
              className="h-8 px-3 rounded-md border border-border text-xs inline-flex items-center gap-1 text-primary"
            >
              <XCircle className="w-3.5 h-3.5" /> 驳回
            </button>
          </div>
        )}
        {showReject && (
          <div className="space-y-1.5">
            <textarea
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              placeholder="驳回原因（写回节点备注）"
              className="w-full h-16 px-2 py-1.5 rounded border border-border bg-base text-xs outline-none focus:border-accent resize-none"
            />
            <button
              onClick={() => {
                void reject(runId, pending.map(n => n.nodeId), feedback);
                setShowReject(false);
              }}
              className="h-7 px-2.5 rounded bg-red-500 text-white text-xs"
            >
              确认驳回
            </button>
          </div>
        )}
      </footer>
    </aside>
  );
}

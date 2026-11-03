import type { NodeExecution } from '../ipc/types';

const SHORT_NAME: Record<string, string> = {
  codebuddy: 'WorkBuddy',
  trae: 'Trae',
};

export function shortAgent(name: string | undefined): string {
  if (!name) return 'AI';
  return SHORT_NAME[name] ?? name.replace(/\s+/g, '').slice(0, 10);
}

export function formatDuration(ms: number | undefined | null): string {
  if (ms == null || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h${String(m % 60).padStart(2, '0')}m`;
  }
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/** 运行中按 startedAt 实时算，结束后用固定 durationMs。 */
export function liveDuration(exec: NodeExecution | null | undefined, now: number): number | undefined {
  if (!exec) return undefined;
  if (exec.durationMs != null) return exec.durationMs;
  const start = Date.parse(exec.startedAt);
  if (Number.isNaN(start)) return undefined;
  return Math.max(0, now - start);
}

export function execLabel(exec: NodeExecution | null | undefined, now: number): string {
  if (!exec) return '';
  const agent = shortAgent(exec.agentName);
  const dur = formatDuration(liveDuration(exec, now));
  switch (exec.state) {
    case 'queued':
      return '排队中';
    case 'running':
      return dur ? `${agent} · 执行中 · ${dur}` : `${agent} · 执行中`;
    case 'awaiting_review':
      return exec.needsConfirmation ? `待确认 · ${agent}` : `待验收 · ${agent}`;
    case 'failed':
      return `失败 · ${agent}`;
    default:
      return '';
  }
}

export function execColor(exec: NodeExecution | null | undefined): string {
  if (!exec) return 'muted';
  if (exec.state === 'running') return 'accent';
  if (exec.state === 'awaiting_review') return 'warning';
  if (exec.state === 'failed') return 'danger';
  return 'muted';
}

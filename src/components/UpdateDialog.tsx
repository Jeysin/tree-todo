/** 更新弹窗（docs/08 §6.3）：版本号 + 版本介绍 + 下载进度 / macOS 下载页降级。 */
import { useEffect } from 'react';
import { ArrowRight, Loader2, X } from 'lucide-react';

import { useRunStore } from '../stores/runStore';
import { IS_MACOS, useUpdateStore } from '../stores/updateStore';

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 版本介绍按纯文本渲染：`- ` 变列表，`**x**` 去星号，标题行加粗。 */
function ReleaseNotes({ notes }: { notes: string }) {
  const lines = notes.split('\n');
  const firstIndex = lines.findIndex(line => line.trim() !== '');
  return (
    <div className="max-h-[220px] overflow-y-auto rounded-lg border border-border bg-base px-3 py-2.5 text-[12.5px] leading-6 text-muted">
      {lines.map((raw, i) => {
        const line = raw.trim();
        if (!line) return <div key={i} className="h-1.5" />;
        const text = line.replace(/\*\*/g, '');
        if (text.startsWith('- ')) {
          return (
            <div key={i} className="flex gap-1.5">
              <span className="text-accent">·</span>
              <span>{text.slice(2)}</span>
            </div>
          );
        }
        const emphasized = i === firstIndex || /^#{1,6}\s/.test(text);
        return (
          <div key={i} className={emphasized ? 'font-medium text-primary' : ''}>
            {text.replace(/^#{1,6}\s/, '')}
          </div>
        );
      })}
    </div>
  );
}

export function UpdateDialog() {
  const open = useUpdateStore(s => s.dialogOpen);
  const phase = useUpdateStore(s => s.phase);
  const info = useUpdateStore(s => s.info);
  const progress = useUpdateStore(s => s.progress);
  const error = useUpdateStore(s => s.error);
  const install = useUpdateStore(s => s.install);
  const closeDialog = useUpdateStore(s => s.closeDialog);

  const runs = useRunStore(s => s.runs);
  const runningCount = runs.filter(r => r.status === 'running' || r.status === 'queued').length;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeDialog]);

  if (!open || !info) return null;

  const busy = phase === 'downloading' || phase === 'installing';
  const percent =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  const primaryLabel =
    phase === 'checking'
      ? '检查中…'
      : phase === 'downloading'
        ? '下载中…'
        : phase === 'installing'
          ? '安装中…'
          : phase === 'error'
            ? '重试'
            : IS_MACOS
              ? '前往下载'
              : '立即更新';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-6"
      onMouseDown={e => {
        if (e.target === e.currentTarget) closeDialog();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        className="w-[460px] max-w-full overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl"
      >
        <header className="flex h-11 items-center justify-between border-b border-border px-4">
          <h2 id="update-dialog-title" className="text-[13px] font-medium text-primary">
            发现新版本
          </h2>
          <button
            onClick={closeDialog}
            disabled={phase === 'installing'}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-base hover:text-primary disabled:opacity-40"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-3 px-4 py-4">
          <div className="flex items-center gap-2 text-[13px] tabular-nums">
            <span className="text-muted">v{info.currentVersion}</span>
            <ArrowRight className="h-3.5 w-3.5 text-muted/60" />
            <span className="font-semibold text-accent">v{info.version}</span>
            {info.date && (
              <span className="ml-auto text-[11px] text-muted/70">{info.date.slice(0, 10)}</span>
            )}
          </div>

          <ReleaseNotes notes={info.notes || '本次更新暂无说明。'} />

          {IS_MACOS ? (
            <p className="text-[11px] leading-4 text-muted/80">
              macOS 版暂不支持应用内安装，将打开 GitHub Releases 下载页；Windows 版可直接下载安装。
            </p>
          ) : (
            runningCount > 0 && (
              <p className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-4 text-warning">
                有 {runningCount} 个任务正在执行，更新会重启应用；执行记录会保留。
              </p>
            )
          )}

          {busy && (
            <div className="space-y-1.5">
              <div className="h-1.5 overflow-hidden rounded-full border border-border bg-base">
                <div
                  className="h-full bg-accent transition-[width] duration-200"
                  style={{ width: `${percent ?? (phase === 'installing' ? 100 : 8)}%` }}
                />
              </div>
              <div className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted">
                {phase === 'installing' ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    正在安装，应用即将重启…
                  </>
                ) : percent != null ? (
                  <span>
                    正在下载 {percent}% · {formatSize(progress.downloaded)} /{' '}
                    {formatSize(progress.total ?? progress.downloaded)}
                  </span>
                ) : (
                  <span>正在下载 · {formatSize(progress.downloaded)}</span>
                )}
              </div>
            </div>
          )}

          {phase === 'error' && error && <p className="text-[12px] text-red-500">{error}</p>}
        </div>

        <footer className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={closeDialog}
            disabled={phase === 'installing'}
            className="h-8 rounded-lg border border-border px-3 text-[13px] text-muted transition-colors hover:bg-base hover:text-primary disabled:opacity-40"
          >
            稍后
          </button>
          <button
            autoFocus
            onClick={() => void install()}
            disabled={busy || phase === 'checking'}
            className="h-8 rounded-lg bg-accent px-4 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {primaryLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

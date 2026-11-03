import { useEffect, useMemo, useState } from 'react';
import { FolderCog, Keyboard, Plug, RefreshCw, Sun, Trash2 } from 'lucide-react';

import { ipc } from '../../ipc';
import type { McpConfig } from '../../ipc/types';
import { useTodoStore } from '../../stores/todoStore';
import { useRunStore } from '../../stores/runStore';

const THEMES = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
] as const;

/** 一键复制 MCP 配置的目标（docs/06 v2 §4.4）。 */
const MCP_TARGETS = [
  { id: 'trae', label: 'Trae / Cursor', agentName: 'Trae' },
  { id: 'claude', label: 'Claude Code', agentName: 'Claude Code' },
  { id: 'codex', label: 'Codex', agentName: 'Codex' },
  { id: 'generic', label: '通用 JSON', agentName: null },
] as const;

function mcpSnippet(config: McpConfig, agentName: string | null): string {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
  };
  if (agentName) headers['X-Tree-Todo-Agent'] = agentName;
  return JSON.stringify(
    {
      mcpServers: {
        'tree-todo': {
          url: config.url ?? 'http://127.0.0.1:39401/mcp',
          headers,
        },
      },
    },
    null,
    2,
  );
}

export function SettingsView() {
  const theme = useTodoStore(s => s.theme);
  const setTheme = useTodoStore(s => s.setTheme);
  const showToast = useTodoStore(s => s.showToast);
  const [purging, setPurging] = useState(false);
  const [mcp, setMcp] = useState<McpConfig | null>(null);
  const [target, setTarget] = useState<(typeof MCP_TARGETS)[number]['id']>('trae');
  /** 回收站保留天数（null = 还没加载完）。 */
  const [retention, setRetention] = useState<number | null>(null);
  const [retentionDraft, setRetentionDraft] = useState('30');
  const [savingRetention, setSavingRetention] = useState(false);

  const loadMcp = async () => {
    try {
      setMcp(await ipc.getMcpConfig());
    } catch (e) {
      showToast((e as { message?: string })?.message ?? '读取 MCP 配置失败');
    }
  };

  const loadSettings = async () => {
    try {
      const s = await ipc.getSettings();
      setRetention(s.trashRetentionDays);
      setRetentionDraft(String(s.trashRetentionDays));
    } catch (e) {
      showToast((e as { message?: string })?.message ?? '读取设置失败');
    }
  };

  useEffect(() => {
    if (!mcp) void loadMcp();
    void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveRetention = async () => {
    if (retention === null) return;
    const raw = retentionDraft.trim();
    const days = Number(raw);
    if (raw === '' || !Number.isFinite(days) || days < 0 || days > 3650) {
      showToast('保留天数需在 0–3650 之间（0 表示不自动清理）');
      setRetentionDraft(String(retention));
      return;
    }
    const next = Math.round(days);
    setRetentionDraft(String(next));
    if (next === retention) return;
    setSavingRetention(true);
    try {
      const s = await ipc.setTrashRetentionDays(next);
      setRetention(s.trashRetentionDays);
      showToast(
        next === 0
          ? '已关闭回收站自动清理'
          : `回收站将自动清理删除超过 ${next} 天的内容`,
      );
      await useTodoStore.getState().loadTrash();
    } catch (e) {
      showToast((e as { message?: string })?.message ?? '保存失败');
      setRetentionDraft(String(retention));
    } finally {
      setSavingRetention(false);
    }
  };

  const snippet = useMemo(() => {
    if (!mcp) return '';
    const t = MCP_TARGETS.find(x => x.id === target);
    return mcpSnippet(mcp, t?.agentName ?? null);
  }, [mcp, target]);

  const copySnippet = async () => {
    try {
      await ipc.copyText(snippet);
      showToast('MCP 配置已复制，粘贴到 Agent 的 MCP 设置里即可');
    } catch (e) {
      showToast((e as { message?: string })?.message ?? '复制失败');
    }
  };

  const resetToken = async () => {
    try {
      const next = await ipc.resetMcpToken();
      setMcp(next);
      showToast('token 已重置；已配置的 Agent 需要更新配置');
    } catch (e) {
      showToast((e as { message?: string })?.message ?? '重置失败');
    }
  };

  const purge = async (beforeDays: number) => {
    setPurging(true);
    try {
      const n = await ipc.purgeRuns(beforeDays);
      showToast(n > 0 ? `已清理 ${n} 条运行记录` : '没有可清理的记录');
      await useRunStore.getState().loadRuns();
    } catch (e) {
      showToast((e as { message?: string })?.message ?? '清理失败');
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-8 py-8 space-y-8">
        <div>
          <h1 className="text-lg font-medium text-primary">设置</h1>
          <p className="text-xs text-muted mt-1">外观、MCP 集成与数据维护。</p>
        </div>

        <section>
          <h2 className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Sun className="w-3.5 h-3.5" /> 外观
          </h2>
          <div className="rounded-lg border border-border bg-surface p-3 flex gap-2">
            {THEMES.map(t => (
              <button
                key={t.value}
                onClick={() => setTheme(t.value)}
                className={[
                  'h-8 px-3 rounded-md text-xs border transition-colors',
                  theme === t.value
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-muted hover:text-primary',
                ].join(' ')}
              >
                {t.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-[11px] font-medium text-muted uppercase tracking-wider flex items-center gap-1.5">
              <Plug className="w-3.5 h-3.5" /> MCP 集成
            </h2>
            <button
              onClick={() => void loadMcp()}
              className="ml-auto h-6 px-2 rounded border border-border text-[11px] text-muted hover:text-primary inline-flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" /> 刷新
            </button>
          </div>
          <div className="rounded-lg border border-border bg-surface px-3 py-3 space-y-3">
            <div className="flex items-center gap-2 text-xs">
              <span
                className={[
                  'w-1.5 h-1.5 rounded-full',
                  mcp?.enabled ? 'bg-success' : 'bg-red-500',
                ].join(' ')}
              />
              <span className="text-primary">
                {mcp?.enabled ? `服务运行中 · ${mcp.url}` : '服务未启动（端口被占用）'}
              </span>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs text-muted">三步接入：</div>
              <ol className="text-xs text-muted/80 leading-5 list-decimal pl-5">
                <li>选目标 Agent，复制下方的 MCP 配置，粘贴进 Agent 的 MCP 设置</li>
                <li>在 tree-todo 里右键「复制 Prompt（带回执）」，粘贴给 Agent</li>
                <li>Agent 开始执行 / 完成时会自动回报，任务节点亮「执行中 / 待验收」</li>
              </ol>
            </div>

            <div className="flex items-center gap-2">
              <select
                value={target}
                onChange={e => setTarget(e.target.value as typeof target)}
                className="h-7 px-2 rounded border border-border bg-base text-xs text-primary outline-none"
              >
                {MCP_TARGETS.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => void copySnippet()}
                className="h-7 px-2.5 rounded border border-border text-xs text-primary hover:bg-base"
              >
                复制 MCP 配置
              </button>
              <button
                onClick={() => void resetToken()}
                className="ml-auto h-7 px-2.5 rounded border border-border text-xs text-muted hover:text-red-500"
              >
                重置 token
              </button>
            </div>

            <pre className="rounded border border-border bg-base px-2.5 py-2 text-[11px] leading-5 text-muted overflow-x-auto font-mono">
              {snippet || '加载中…'}
            </pre>

            <p className="text-[11px] text-muted/70 leading-4">
              token 只在本机回写执行状态（待验收 / 计时），任务完成与否永远由你在 tree-todo 里验收。
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Trash2 className="w-3.5 h-3.5" /> 回收站
          </h2>
          <div className="rounded-lg border border-border bg-surface px-3 py-3 space-y-2">
            <div className="flex items-center gap-2 text-xs text-primary">
              <span>自动清理删除超过</span>
              <input
                type="number"
                min={0}
                max={3650}
                value={retentionDraft}
                disabled={retention === null || savingRetention}
                onChange={e => setRetentionDraft(e.target.value)}
                onBlur={() => void saveRetention()}
                onKeyDown={e => {
                  e.stopPropagation();
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                className="w-16 h-7 px-2 rounded border border-border bg-base text-xs text-primary outline-none focus:border-accent disabled:opacity-40"
              />
              <span>天的内容</span>
              {savingRetention && <span className="text-[11px] text-muted">保存中…</span>}
            </div>
            <p className="text-[11px] text-muted/70 leading-4">
              回收站里的文档与目录会在启动时和运行期间自动清理；填 0 表示不自动清理。
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <FolderCog className="w-3.5 h-3.5" /> 数据
          </h2>
          <div className="rounded-lg border border-border bg-surface px-3 py-3 text-xs text-muted leading-5 space-y-1">
            <div>文档结构版本：schema v4（执行状态 + 运行账本）</div>
            <div>迁移前自动备份到 app_data/backups/v4，失败不会覆盖原文件。</div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              disabled={purging}
              onClick={() => void purge(0)}
              className="h-7 px-2.5 rounded border border-border text-xs text-muted hover:text-primary hover:border-red-500/40 disabled:opacity-40"
            >
              清空执行历史
            </button>
            <button
              disabled={purging}
              onClick={() => void purge(7)}
              className="h-7 px-2.5 rounded border border-border text-xs text-muted hover:text-primary disabled:opacity-40"
            >
              清理 7 天前
            </button>
            <span className="text-[11px] text-muted/70">待验收的记录不会被清除。</span>
          </div>
        </section>

        <section>
          <h2 className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Keyboard className="w-3.5 h-3.5" /> 快捷键
          </h2>
          <div className="rounded-lg border border-border bg-surface px-3 py-3 text-xs text-muted leading-6">
            <div><kbd className="kbd">Alt + Enter</kbd> 打开 / 关闭节点详情</div>
            <div><kbd className="kbd">Ctrl + Shift + C</kbd> 复制 Prompt（纯文本）</div>
            <div><kbd className="kbd">Ctrl + Shift + R</kbd> 复制 Prompt（带回执）</div>
            <div><kbd className="kbd">Ctrl + ,</kbd> 打开设置</div>
          </div>
        </section>
      </div>
    </div>
  );
}

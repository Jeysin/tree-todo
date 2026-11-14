import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  FolderCog,
  Keyboard,
  Languages,
  MessageSquareText,
  Plug,
  RefreshCw,
  Sun,
  Trash2,
} from 'lucide-react';

import { localizedError, setLang, useLang, useT } from '../../i18n';
import { ipc } from '../../ipc';
import type { McpConfig } from '../../ipc/types';
import { useTodoStore } from '../../stores/todoStore';
import { useRunStore } from '../../stores/runStore';

/** 约束文本上限（与 Rust `MAX_PROMPT_CONSTRAINTS_CHARS` 保持一致）。 */
const MAX_CONSTRAINTS_CHARS = 2000;

const THEME_KEYS = [
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
  const t = useT();
  const lang = useLang();
  const theme = useTodoStore(s => s.theme);
  const setTheme = useTodoStore(s => s.setTheme);
  const showToast = useTodoStore(s => s.showToast);
  const previousViewMode = useTodoStore(s => s.previousViewMode);
  const setViewMode = useTodoStore(s => s.setViewMode);
  const [purging, setPurging] = useState(false);
  const [mcp, setMcp] = useState<McpConfig | null>(null);
  const [savingMcp, setSavingMcp] = useState(false);
  const [target, setTarget] = useState<(typeof MCP_TARGETS)[number]['id']>('trae');
  /** 回收站保留天数（null = 还没加载完）。 */
  const [retention, setRetention] = useState<number | null>(null);
  const [retentionDraft, setRetentionDraft] = useState('30');
  const [savingRetention, setSavingRetention] = useState(false);
  /** Prompt 约束段：已保存值 / 编辑中的草稿 / 内置默认（均由 Rust 提供）。 */
  const [constraints, setConstraints] = useState('');
  const [constraintsDraft, setConstraintsDraft] = useState('');
  const [defaultConstraints, setDefaultConstraints] = useState('');
  const [savingConstraints, setSavingConstraints] = useState(false);

  const loadMcp = async () => {
    try {
      setMcp(await ipc.getMcpConfig());
    } catch (e) {
      showToast(localizedError(e, t('读取 MCP 配置失败')));
    }
  };

  const loadSettings = async () => {
    try {
      const s = await ipc.getSettings();
      setRetention(s.trashRetentionDays);
      setRetentionDraft(String(s.trashRetentionDays));
      setConstraints(s.promptConstraints);
      setConstraintsDraft(s.promptConstraints);
      setDefaultConstraints(s.defaultPromptConstraints);
    } catch (e) {
      showToast(localizedError(e, t('读取设置失败')));
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
      showToast(t('保留天数需在 0–3650 之间（0 表示不自动清理）'));
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
          ? t('已关闭回收站自动清理')
          : t('回收站将自动清理删除超过 {n} 天的内容', { n: next }),
      );
      await useTodoStore.getState().loadTrash();
    } catch (e) {
      showToast(localizedError(e, t('保存失败')));
      setRetentionDraft(String(retention));
    } finally {
      setSavingRetention(false);
    }
  };

  const snippet = useMemo(() => {
    if (!mcp) return '';
    const targetInfo = MCP_TARGETS.find(x => x.id === target);
    return mcpSnippet(mcp, targetInfo?.agentName ?? null);
  }, [mcp, target]);

  const constraintChars = Array.from(constraintsDraft).length;
  const constraintsDirty = constraintsDraft !== constraints;

  const saveConstraints = async (text: string, okText?: string) => {
    if (Array.from(text).length > MAX_CONSTRAINTS_CHARS) {
      showToast(t('约束最多 {n} 个字符', { n: MAX_CONSTRAINTS_CHARS }));
      return;
    }
    setSavingConstraints(true);
    try {
      const s = await ipc.setPromptConstraints(text);
      // 以 Rust 规整后的文本为准（空行会被去掉、空文本回落默认），不留第二份真相。
      setConstraints(s.promptConstraints);
      setConstraintsDraft(s.promptConstraints);
      setDefaultConstraints(s.defaultPromptConstraints);
      showToast(
        okText ??
          (text.trim() === '' ? t('已恢复默认约束') : t('约束已保存，下次复制 Prompt 生效')),
      );
    } catch (e) {
      showToast(localizedError(e, t('保存失败')));
    } finally {
      setSavingConstraints(false);
    }
  };

  const restoreConstraints = () => {
    setConstraintsDraft(defaultConstraints);
    void saveConstraints(defaultConstraints, t('已恢复默认约束'));
  };

  const copySnippet = async () => {
    try {
      await ipc.copyText(snippet);
      showToast(t('MCP 配置已复制，粘贴到 Agent 的 MCP 设置里即可'));
    } catch (e) {
      showToast(localizedError(e, t('复制失败')));
    }
  };

  const resetToken = async () => {
    try {
      const next = await ipc.resetMcpToken();
      setMcp(next);
      showToast(t('token 已重置；已配置的 Agent 需要更新配置'));
    } catch (e) {
      showToast(localizedError(e, t('重置失败')));
    }
  };

  /** MCP 开关：关闭会立即停止本地监听并释放端口；开启时重新绑定。 */
  const toggleMcp = async (enabled: boolean) => {
    if (savingMcp) return;
    setSavingMcp(true);
    try {
      const next = await ipc.setMcpEnabled(enabled);
      setMcp(next);
      showToast(enabled ? t('MCP 服务已开启') : t('MCP 服务已关闭'));
    } catch (e) {
      showToast(localizedError(e, t('保存失败')));
      await loadMcp();
    } finally {
      setSavingMcp(false);
    }
  };

  const purge = async (beforeDays: number) => {
    setPurging(true);
    try {
      const n = await ipc.purgeRuns(beforeDays);
      showToast(n > 0 ? t('已清理 {n} 条运行记录', { n }) : t('没有可清理的记录'));
      await useRunStore.getState().loadRuns();
    } catch (e) {
      showToast(localizedError(e, t('清理失败')));
    } finally {
      setPurging(false);
    }
  };

  const mcpStatus = (() => {
    if (!mcp) return { dot: 'bg-muted', text: t('加载中…') };
    if (!mcp.enabled) return { dot: 'bg-muted', text: t('服务已关闭') };
    return mcp.running
      ? { dot: 'bg-success', text: t('服务运行中 · {url}', { url: mcp.url ?? '' }) }
      : { dot: 'bg-red-500', text: t('服务未启动（端口被占用）') };
  })();

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-8 py-8 space-y-8">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-medium text-primary">{t('设置')}</h1>
            <p className="text-xs text-muted mt-1">
              {t('外观、语言、Prompt 约束、MCP 集成与数据维护。')}
            </p>
          </div>
          <button
            onClick={() => setViewMode(previousViewMode)}
            className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-border text-[13px] text-primary hover:bg-base transition-colors shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            {t('返回')}
          </button>
        </header>

        <section>
          <h2 className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Sun className="w-3.5 h-3.5" /> {t('外观')}
          </h2>
          <div className="rounded-lg border border-border bg-surface p-3 flex gap-2">
            {THEME_KEYS.map(item => (
              <button
                key={item.value}
                onClick={() => setTheme(item.value)}
                className={[
                  'h-8 px-3 rounded-md text-xs border transition-colors',
                  theme === item.value
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-muted hover:text-primary',
                ].join(' ')}
              >
                {t(item.label)}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Languages className="w-3.5 h-3.5" /> {t('语言')}
          </h2>
          <div className="rounded-lg border border-border bg-surface p-3 space-y-2">
            <div className="flex gap-2">
              {(
                [
                  { value: 'zh', label: '中文' },
                  { value: 'en', label: 'English' },
                ] as const
              ).map(item => (
                <button
                  key={item.value}
                  onClick={() => setLang(item.value)}
                  className={[
                    'h-8 px-3 rounded-md text-xs border transition-colors',
                    lang === item.value
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-muted hover:text-primary',
                  ].join(' ')}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted/70 leading-4">
              {t('安装后默认按系统时区选择；可随时在这里切换。')}
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <MessageSquareText className="w-3.5 h-3.5" /> Prompt
          </h2>
          <div className="rounded-lg border border-border bg-surface px-3 py-3 space-y-2.5">
            <div className="space-y-1">
              <div className="text-xs text-primary">{t('「约束」段')}</div>
              <p className="text-[11px] text-muted/70 leading-4">
                {t('复制 Prompt（纯文本 / 带回执）时附在末尾，两个变体共用。每行一条，复制时自动加上「- 」前缀；清空后保存等于恢复默认。')}
              </p>
            </div>
            <textarea
              value={constraintsDraft}
              onChange={e => setConstraintsDraft(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={t('每行一条约束')}
              className="w-full resize-y rounded border border-border bg-base px-2.5 py-2 text-xs leading-5 font-mono text-primary outline-none focus:border-accent"
            />
            <div className="flex items-center gap-2">
              <button
                disabled={!constraintsDirty || savingConstraints}
                onClick={() => void saveConstraints(constraintsDraft)}
                className="h-7 px-2.5 rounded border border-border text-xs text-primary hover:bg-base disabled:opacity-40"
              >
                {savingConstraints ? t('保存中…') : t('保存约束')}
              </button>
              <button
                disabled={savingConstraints || constraints === defaultConstraints}
                onClick={restoreConstraints}
                className="h-7 px-2.5 rounded border border-border text-xs text-muted hover:text-primary disabled:opacity-40"
              >
                {t('恢复默认')}
              </button>
              <span
                className={[
                  'ml-auto text-[11px] tabular-nums',
                  constraintChars > MAX_CONSTRAINTS_CHARS ? 'text-red-500' : 'text-muted/70',
                ].join(' ')}
              >
                {constraintChars}/{MAX_CONSTRAINTS_CHARS}
              </span>
            </div>
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-[11px] font-medium text-muted uppercase tracking-wider flex items-center gap-1.5">
              <Plug className="w-3.5 h-3.5" /> {t('MCP 集成')}
            </h2>
            <button
              onClick={() => void loadMcp()}
              className="ml-auto h-6 px-2 rounded border border-border text-[11px] text-muted hover:text-primary inline-flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" /> {t('刷新')}
            </button>
          </div>
          <div className="rounded-lg border border-border bg-surface px-3 py-3 space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 text-xs min-w-0">
                <span className={['w-1.5 h-1.5 rounded-full shrink-0', mcpStatus.dot].join(' ')} />
                <span className="text-primary truncate">{mcpStatus.text}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={mcp?.enabled ?? true}
                aria-label={t('启用 MCP 服务')}
                disabled={!mcp || savingMcp}
                onClick={() => void toggleMcp(!(mcp?.enabled ?? true))}
                className={[
                  'ml-auto relative w-9 h-5 rounded-full transition-colors shrink-0 disabled:opacity-40',
                  mcp?.enabled ? 'bg-accent' : 'bg-border',
                ].join(' ')}
              >
                <span
                  className={[
                    'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                    mcp?.enabled ? 'translate-x-4' : '',
                  ].join(' ')}
                />
              </button>
            </div>

            <div className="space-y-1">
              <div className="text-xs text-primary">{t('启用 MCP 服务')}</div>
              <p className="text-[11px] text-muted/70 leading-4">
                {t('默认开启；关闭后本地 MCP 服务会停止，Agent 无法回写执行状态。')}
              </p>
            </div>

            {mcp?.enabled ? (
              <>
                <div className="space-y-1.5">
                  <div className="text-xs text-muted">{t('三步接入：')}</div>
                  <ol className="text-xs text-muted/80 leading-5 list-decimal pl-5">
                    <li>{t('选目标 Agent，复制下方的 MCP 配置，粘贴进 Agent 的 MCP 设置')}</li>
                    <li>{t('在 tree-todo 里右键「复制 Prompt（带回执）」，粘贴给 Agent')}</li>
                    <li>{t('Agent 开始执行 / 完成时会自动回报，任务节点亮「执行中 / 待验收」')}</li>
                  </ol>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={target}
                    onChange={e => setTarget(e.target.value as typeof target)}
                    className="h-7 px-2 rounded border border-border bg-base text-xs text-primary outline-none"
                  >
                    {MCP_TARGETS.map(item => (
                      <option key={item.id} value={item.id}>
                        {t(item.label)}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => void copySnippet()}
                    className="h-7 px-2.5 rounded border border-border text-xs text-primary hover:bg-base"
                  >
                    {t('复制 MCP 配置')}
                  </button>
                  <button
                    onClick={() => void resetToken()}
                    className="ml-auto h-7 px-2.5 rounded border border-border text-xs text-muted hover:text-red-500"
                  >
                    {t('重置 token')}
                  </button>
                </div>

                <pre className="rounded border border-border bg-base px-2.5 py-2 text-[11px] leading-5 text-muted overflow-x-auto font-mono">
                  {snippet || t('加载中…')}
                </pre>

                <p className="text-[11px] text-muted/70 leading-4">
                  {t('token 只在本机回写执行状态（待验收 / 计时），任务完成与否永远由你在 tree-todo 里验收。')}
                </p>
              </>
            ) : (
              <p className="text-[11px] text-muted/70 leading-4">
                {t('MCP 服务已关闭时，复制 Prompt（带回执）仍然可用，但 Agent 不会回写执行状态。')}
              </p>
            )}
          </div>
        </section>

        <section>
          <h2 className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Trash2 className="w-3.5 h-3.5" /> {t('回收站')}
          </h2>
          <div className="rounded-lg border border-border bg-surface px-3 py-3 space-y-2">
            <div className="flex items-center gap-2 text-xs text-primary">
              <span>{t('自动清理删除超过')}</span>
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
              <span>{t('天的内容')}</span>
              {savingRetention && <span className="text-[11px] text-muted">{t('保存中…')}</span>}
            </div>
            <p className="text-[11px] text-muted/70 leading-4">
              {t('回收站里的文档与目录会在启动时和运行期间自动清理；填 0 表示不自动清理。')}
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <FolderCog className="w-3.5 h-3.5" /> {t('数据')}
          </h2>
          <div className="rounded-lg border border-border bg-surface px-3 py-3 text-xs text-muted leading-5 space-y-1">
            <div>{t('文档结构版本：schema v4（执行状态 + 运行账本）')}</div>
            <div>{t('迁移前自动备份到 app_data/backups/v4，失败不会覆盖原文件。')}</div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              disabled={purging}
              onClick={() => void purge(0)}
              className="h-7 px-2.5 rounded border border-border text-xs text-muted hover:text-primary hover:border-red-500/40 disabled:opacity-40"
            >
              {t('清空执行历史')}
            </button>
            <button
              disabled={purging}
              onClick={() => void purge(7)}
              className="h-7 px-2.5 rounded border border-border text-xs text-muted hover:text-primary disabled:opacity-40"
            >
              {t('清理 7 天前')}
            </button>
            <span className="text-[11px] text-muted/70">{t('待验收的记录不会被清除。')}</span>
          </div>
        </section>

        <section>
          <h2 className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Keyboard className="w-3.5 h-3.5" /> {t('快捷键')}
          </h2>
          <div className="rounded-lg border border-border bg-surface px-3 py-3 text-xs text-muted leading-6">
            <div><kbd className="kbd">Alt + Enter</kbd> {t('打开 / 关闭节点详情')}</div>
            <div><kbd className="kbd">Ctrl + Shift + C</kbd> {t('复制 Prompt（纯文本）')}</div>
            <div><kbd className="kbd">Ctrl + Shift + R</kbd> {t('复制 Prompt（带回执）')}</div>
            <div><kbd className="kbd">Ctrl + ,</kbd> {t('打开设置')}</div>
          </div>
        </section>
      </div>
    </div>
  );
}

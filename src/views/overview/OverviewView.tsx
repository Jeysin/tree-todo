/**
 * 总览（docs/10 §7）：全局层唯一入口，跨全部活动文档的叶子完成记录。
 * 数据来自 global.db 聚合（Rust 侧计算），本组件不做任何统计运算。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CalendarDays, Flame, Info, Layers, Loader2, TrendingUp } from 'lucide-react';

import { DocPicker } from '../../components/DocPicker';
import { availableYears } from '../../lib/heatmap';
import { useOverviewStore } from '../../stores/overviewStore';
import { useTodoStore } from '../../stores/todoStore';
import { DayDetailPanel } from './DayDetailPanel';
import { HeatmapGrid } from './HeatmapGrid';

const INFO_TEXT =
  '统计的是当前仍存在的叶子任务的完成时间。父节点是分类，不计入；删除任务、或把文档移入回收站，会让对应日期的数字减少。回收站里的文档从恢复那一刻起重新计入。按当前时区划分日期，更换时区后历史会重新归位。';

export function OverviewView() {
  const response = useOverviewStore(s => s.response);
  const loading = useOverviewStore(s => s.loading);
  const error = useOverviewStore(s => s.error);
  const selectedDate = useOverviewStore(s => s.selectedDate);
  const range = useOverviewStore(s => s.range);
  const year = useOverviewStore(s => s.year);
  const scope = useOverviewStore(s => s.scope);
  const load = useOverviewStore(s => s.load);
  const selectDate = useOverviewStore(s => s.selectDate);
  const setRange = useOverviewStore(s => s.setRange);
  const setYear = useOverviewStore(s => s.setYear);
  const setScope = useOverviewStore(s => s.setScope);

  const documents = useTodoStore(s => s.documents);
  const folders = useTodoStore(s => s.folders);

  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    void load();
  }, [load]);

  // 断点按「主区实际宽度」而不是视口宽度：带侧栏时 800px 窗口主区只有 ~536px，
  // 用 sm:/lg: 这类视口断点会把 KPI 挤成折行的两行字。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      setWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const wide = width >= 1040;
  const kpiCols = width >= 620 ? 'grid-cols-4' : 'grid-cols-2';

  // 年份从发布年推到今年，不在代码里逐年写死（2026 只有 1 个，2027 有 2 个…）
  const years = availableYears();

  const scopeDocId = scope.kind === 'document' ? scope.docId : null;
  const scopeDoc = scopeDocId ? documents.find(d => d.id === scopeDocId) : undefined;

  // 选中的文档被删除 / 移入回收站后，自动回到「全部文档」，避免停在一个不存在的范围上。
  useEffect(() => {
    if (scopeDocId && documents.length > 0 && !scopeDoc) setScope({ kind: 'all' });
  }, [scopeDocId, scopeDoc, documents, setScope]);

  const days = response?.days ?? [];
  const hasAny = (response?.totalLeafDone ?? 0) > 0;

  return (
    <div ref={containerRef} className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-6 py-5">
        {/* 页头 */}
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="text-[20px] font-semibold tracking-tight text-primary">总览</h1>
              <span title={INFO_TEXT} aria-label={INFO_TEXT} className="text-muted/70 hover:text-muted cursor-help">
                <Info className="w-3.5 h-3.5" />
              </span>
            </div>
            <p className="mt-1 text-[12px] text-muted">
              {scopeDoc ? `「${scopeDoc.name}」的` : '全部文档的'}叶子任务完成记录 · 不含回收站
            </p>
          </div>

          <div className="flex items-center gap-2">
            <DocPicker
              documents={documents}
              folders={folders}
              value={scopeDoc?.id ?? null}
              onChange={id => setScope(id ? { kind: 'document', docId: id } : { kind: 'all' })}
              allLabel="全部文档"
              ariaLabel="统计范围"
            />
            <select
              value={range === 'last12m' ? 'last12m' : String(year)}
              onChange={e => {
                const value = e.target.value;
                if (value === 'last12m') setRange('last12m');
                else setYear(Number(value));
              }}
              aria-label="时间范围"
              className="h-8 rounded-md border border-border bg-surface px-2 text-[12px] text-primary outline-none focus:border-accent/60"
            >
              <option value="last12m">近 12 个月</option>
              {years.map(y => (
                <option key={y} value={y}>
                  {y} 年
                </option>
              ))}
            </select>
          </div>
        </header>

        {/* KPI */}
        <div className={`grid ${kpiCols} gap-3`}>
          <Kpi icon={<TrendingUp className="w-3.5 h-3.5" />} label="范围内完成" value={response?.totalLeafDone ?? 0} />
          <Kpi icon={<CalendarDays className="w-3.5 h-3.5" />} label="活跃天数" value={response?.activeDays ?? 0} />
          <Kpi icon={<Flame className="w-3.5 h-3.5" />} label="当前连续" value={response?.currentStreak ?? 0} unit="天" />
          <Kpi icon={<Layers className="w-3.5 h-3.5" />} label="最长连续" value={response?.longestStreak ?? 0} unit="天" />
        </div>

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-2.5 text-[12px]">
            <span className="text-warning">数据读取失败：{error}</span>
            <button
              type="button"
              onClick={() => void load()}
              className="text-accent hover:underline shrink-0"
            >
              重试
            </button>
          </div>
        )}

        {response?.stale && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2 text-[11.5px] text-muted">
            <Loader2 className="w-3 h-3 animate-spin" />
            正在同步历史数据…
          </div>
        )}

        <div className={wide ? 'flex items-start gap-4' : 'flex flex-col gap-4'}>
          <section className="min-w-0 flex-1 rounded-xl border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-[13px] font-semibold text-primary">完成记录</h2>
              <span className="text-[11px] text-muted tabular-nums">
                {loading && !days.length ? '读取中…' : `${response?.totalLeafDone ?? 0} 个任务`}
              </span>
            </div>
            <HeatmapGrid
              days={days}
              selectedDate={selectedDate}
              loading={loading}
              onSelect={date => void selectDate(date)}
            />
            {!loading && response && !hasAny && (
              <p className="mt-3 rounded-md bg-base px-3 py-2 text-[11.5px] text-muted">
                完成第一个任务后，这里会亮起第一格。
              </p>
            )}
          </section>

          <div className={wide ? 'w-[300px] shrink-0' : ''}>
            <DayDetailPanel />
          </div>
        </div>

        <p className="pb-1 text-[10.5px] leading-4 text-muted/70">
          只看「当前仍存在」的叶子任务：父节点是分类，永不计数。文档进回收站后其完成记录一并移出，恢复后重新计入。
        </p>
      </div>
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  unit,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  unit?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted select-none whitespace-nowrap">
        <span className="text-muted/80">{icon}</span>
        {label}
      </div>
      <div className="mt-1 text-[22px] font-semibold leading-7 text-primary tabular-nums">
        {value}
        {unit && <span className="ml-0.5 text-[11px] font-normal text-muted">{unit}</span>}
      </div>
    </div>
  );
}

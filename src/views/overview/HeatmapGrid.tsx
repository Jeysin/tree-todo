/**
 * 53×7 日历热力图（docs/10 §7.2–§7.4）。
 * 只负责画格子与命中点击；统计口径、色阶阈值都来自纯函数 / Rust 返回值。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { useLang, useT } from '../../i18n';
import type { DayCount } from '../../ipc/types';
import {
  buildCalendar,
  computeThresholds,
  formatDateShort,
  formatDay,
  weekdayLabels,
  type HeatCell,
} from '../../lib/heatmap';

const LEVEL_CLASS = ['bg-heat-0', 'bg-heat-1', 'bg-heat-2', 'bg-heat-3', 'bg-heat-4'];

/** 星期标签列宽；格子宽度预算里要先扣掉它。 */
const LABEL_WIDTH = 18;
/**
 * 月份标签（如「12月」）比单个格子宽，最后一列的文字会向右溢出约 20px。
 * 这段溢出同样计入滚动宽度，预算里预留出来，否则整年明明排得下也会冒出横向滚动条。
 */
const MONTH_LABEL_OVERFLOW = 24;

/**
 * 给定容器宽度，选一组「格子边长 + 列间距」。
 * 53 列 + 52 个列间距 + 月份标签右溢必须压进一行，所以先保住格子边长，
 * 再依次收缩列间距（3 → 2 → 1px）；格子最小 6px，比这还窄才退回横向滚动。
 */
function pickMetrics(width: number): { cell: number; gap: number } {
  const avail = width - LABEL_WIDTH - MONTH_LABEL_OVERFLOW - 2;
  for (const gap of [3, 2, 1]) {
    const fit = Math.floor((avail - 52 * gap) / 53);
    if (fit >= 6) return { cell: Math.min(10, fit), gap };
  }
  return { cell: 6, gap: 1 };
}

/**
 * 月份标签避让。标签比格子宽得多（「12月」约 26px，而一列只有 6–10px），
 * 相邻两个月的文字会互相压住，所以按实际列距决定「隔几列才放得下」：
 * 1. 自然年视图首列常是上一年的残月（如 2025-12-29），只占 1 列就换月——
 *    丢掉它，让「1月」露出来，否则「12月」会把「1月」整个盖住；
 * 2. 其余标签未满最小列距就跳过，宁缺不叠。
 */
function pickMonthLabels(weeks: { monthLabel: string | null }[], pitch: number): Set<number> {
  const marks = weeks.flatMap((week, index) => (week.monthLabel ? [index] : []));
  while (marks.length > 1 && marks[1] - marks[0] <= 1) marks.shift();

  const need = Math.max(2, Math.ceil(28 / Math.max(1, pitch)));
  const visible = new Set<number>();
  let last = Number.NEGATIVE_INFINITY;
  for (const index of marks) {
    if (index - last >= need) {
      visible.add(index);
      last = index;
    }
  }
  return visible;
}

interface Props {
  days: DayCount[];
  selectedDate: string | null;
  loading: boolean;
  onSelect: (date: string) => void;
}

export function HeatmapGrid({ days, selectedDate, loading, onSelect }: Props) {
  const t = useT();
  const lang = useLang();
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ cell: 10, gap: 3 });
  const { cell, gap } = metrics;

  // 容器变宽变窄都重新选一档密度，保证整年默认一屏放下。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width <= 0) return;
      setMetrics(pickMetrics(width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { weeks, thresholds } = useMemo(() => {
    if (days.length === 0) {
      return { weeks: [], thresholds: [1, 2, 3, 4] };
    }
    const counts = new Map(days.map(d => [d.date, d.leafDone]));
    const values = days.map(d => d.leafDone);
    const thresholds = computeThresholds(values);
    const model = buildCalendar(
      days[0].date,
      days[days.length - 1].date,
      counts,
      thresholds,
      formatDay(new Date()),
    );
    return { weeks: model.weeks, thresholds };
  }, [days, lang]);

  // 默认滚到最右（最近一周）。
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [weeks.length, cell]);

  // 标签避让依赖列距，所以放在 cell / gap 变化之后算。
  const monthLabels = useMemo(
    () => pickMonthLabels(weeks, cell + gap),
    [weeks, cell, gap],
  );

  if (loading && days.length === 0) {
    return (
      <div className="h-[110px] flex items-center justify-center text-xs text-muted">
        {t('正在读取完成记录…')}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="w-full">
      <div ref={scrollRef} className="overflow-x-auto pb-1">
        <div className="inline-flex flex-col gap-1 min-w-max">
          {/* 月份标签：与下方格子共用列宽，同月只在首列出现一次 */}
          <div className="flex">
            <div style={{ width: LABEL_WIDTH }} className="shrink-0" />
            <div
              className="grid"
              style={{
                gridTemplateColumns: `repeat(${weeks.length}, ${cell}px)`,
                columnGap: gap,
              }}
            >
              {weeks.map((week, index) =>
                monthLabels.has(index) ? (
                  <span
                    key={`m-${week.cells[0]?.date ?? index}`}
                    style={{ gridColumnStart: index + 1 }}
                    className="text-[10px] leading-3 text-muted whitespace-nowrap select-none"
                  >
                    {week.monthLabel}
                  </span>
                ) : null,
              )}
            </div>
          </div>

          <div className="flex">
            {/* 星期标签：只标一 / 三 / 五，避免拥挤 */}
            <div
              className="grid shrink-0"
              style={{ width: LABEL_WIDTH, gridTemplateRows: `repeat(7, ${cell}px)`, rowGap: gap }}
            >
              {weekdayLabels().map((label, index) => (
                <span
                  key={index}
                  className="text-[9px] leading-none text-muted flex items-center select-none"
                >
                  {index % 2 === 0 ? label : ''}
                </span>
              ))}
            </div>

            <div
              role="grid"
              aria-label={t('日历热力图：每格是一天，颜色越深完成的任务越多')}
              className="grid grid-flow-col"
              style={{
                gridTemplateRows: `repeat(7, ${cell}px)`,
                gridAutoColumns: `${cell}px`,
                gap,
              }}
            >
              {weeks.map(week =>
                week.cells.map(c => (
                  <Cell
                    key={c.date}
                    cell={c}
                    size={cell}
                    selected={selectedDate === c.date}
                    onSelect={onSelect}
                  />
                )),
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[10px] text-muted select-none">
          <span>{t('少')}</span>
          {LEVEL_CLASS.map((cls, index) => (
            <span
              key={cls}
              className={['rounded-[2px]', cls, index === 0 ? 'border border-border/60' : ''].join(' ')}
              style={{ width: cell, height: cell }}
              title={
                index === 0
                  ? t('{n} 个', { n: 0 })
                  : index === 1
                    ? t('1–{n} 个', { n: thresholds[0] })
                    : index === 2
                      ? t('{a}–{b} 个', { a: thresholds[0] + 1, b: thresholds[1] })
                      : index === 3
                        ? t('{a}–{b} 个', { a: thresholds[1] + 1, b: thresholds[2] })
                        : t('≥ {n} 个', { n: thresholds[2] + 1 })
              }
            />
          ))}
          <span>{t('多')}</span>
        </div>
        <span className="text-[10px] text-muted/80 select-none">{t('按本地 00:00 分日')}</span>
      </div>
    </div>
  );
}

function Cell({
  cell,
  size,
  selected,
  onSelect,
}: {
  cell: HeatCell;
  size: number;
  selected: boolean;
  onSelect: (date: string) => void;
}) {
  const t = useT();
  const disabled = cell.outside || cell.future;
  const label = t('{date}，完成 {n} 个任务', {
    date: formatDateShort(cell.date),
    n: cell.count,
  });
  return (
    <button
      type="button"
      role="gridcell"
      disabled={disabled}
      aria-label={label}
      aria-selected={selected}
      title={disabled ? formatDateShort(cell.date) : `${label} · ${t('点击查看明细')}`}
      onClick={() => onSelect(cell.date)}
      style={{ width: size, height: size }}
      className={[
        'rounded-[2px] p-0 transition-[box-shadow,background-color] duration-100',
        cell.outside
          ? 'bg-transparent cursor-default'
          : cell.future
            ? 'bg-transparent border border-border/70'
            : LEVEL_CLASS[cell.level],
        !disabled && cell.level === 0 ? 'border border-border/60' : '',
        disabled ? '' : 'hover:ring-1 hover:ring-accent/60',
        selected ? 'ring-2 ring-accent/80' : '',
      ].join(' ')}
    />
  );
}

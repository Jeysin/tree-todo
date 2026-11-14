/**
 * 日历热力图纯函数（docs/10 §7.2–§7.4）。
 *
 * 约定：所有日期都用 `YYYY-MM-DD` 字符串在边界上传递；内部解析**只用本地构造**
 * `new Date(y, m-1, d)`，禁止 `new Date('2026-11-14')`（按 UTC 解析，东八区会少一天）。
 */

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const;

export interface HeatCell {
  /** YYYY-MM-DD */
  date: string;
  count: number;
  /** 0–4，0 = 没有完成 / 未来 / 补白。 */
  level: number;
  /** 不在查询范围内（首尾补白），不参与统计、不响应点击。 */
  outside: boolean;
  /** 今天之后：渲染为浅色占位，避免被误读为「0 完成」。 */
  future: boolean;
}

export interface HeatWeek {
  cells: HeatCell[];
  /** 该周（周一起）所属月份变化时给一个月标签，否则 null。 */
  monthLabel: string | null;
}

export interface CalendarModel {
  weeks: HeatWeek[];
  /** 分档阈值 [t1, t2, t3, t4]，严格递增。 */
  thresholds: number[];
}

/** ISO 日期 → 本地零点的 Date。 */
export function parseDay(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 本地 Date → YYYY-MM-DD（不受时区偏移影响）。 */
export function formatDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string {
  const d = parseDay(iso);
  d.setDate(d.getDate() + days);
  return formatDay(d);
}

/** 所在周的周一。 */
export function startOfWeek(iso: string): string {
  const d = parseDay(iso);
  const offset = (d.getDay() + 6) % 7; // 周一 = 0，周日 = 6
  d.setDate(d.getDate() - offset);
  return formatDay(d);
}

/** 所在周的周日。 */
export function endOfWeek(iso: string): string {
  return addDays(startOfWeek(iso), 6);
}

/** 线性插值分位数（输入升序）。 */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * p;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  const weight = pos - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * 分档阈值：用所选范围内的相对分位数，避免新用户过陡、重度用户全是最深色。
 * 严格递增化，保证不会出现「两个档位同一个值」导致某档永不出现。
 */
export function computeThresholds(counts: number[]): number[] {
  const positive = counts.filter(n => n > 0).sort((a, b) => a - b);
  if (positive.length === 0) return [1, 2, 3, 4];
  const q1 = quantile(positive, 0.25);
  const q2 = quantile(positive, 0.5);
  const q3 = quantile(positive, 0.75);
  const q4 = quantile(positive, 0.9);
  const t1 = Math.max(1, Math.round(q1));
  const t2 = Math.max(t1 + 1, Math.round(q2));
  const t3 = Math.max(t2 + 1, Math.round(q3));
  const t4 = Math.max(t3 + 1, Math.round(q4));
  return [t1, t2, t3, t4];
}

export function levelFor(count: number, thresholds: number[]): number {
  if (count <= 0) return 0;
  const [t1, t2, t3] = thresholds;
  if (count <= t1) return 1;
  if (count <= t2) return 2;
  if (count <= t3) return 3;
  return 4;
}

/**
 * 构建 53×7 网格：列 = 周（周一 → 周日），行 = 星期。
 * 首尾补白（outside）不参与统计；`todayIso` 之后的日期标记 future。
 */
export function buildCalendar(
  startDate: string,
  endDate: string,
  counts: Map<string, number>,
  thresholds: number[],
  todayIso: string,
): CalendarModel {
  const firstMonday = startOfWeek(startDate);
  const lastSunday = endOfWeek(endDate);
  const weeks: HeatWeek[] = [];

  let cursor = firstMonday;
  let previousMonth = -1;
  while (cursor <= lastSunday) {
    const cells: HeatCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const date = addDays(cursor, i);
      const outside = date < startDate || date > endDate;
      const future = date > todayIso;
      const count = outside ? 0 : (counts.get(date) ?? 0);
      cells.push({
        date,
        count,
        level: outside || future ? 0 : levelFor(count, thresholds),
        outside,
        future,
      });
    }
    const monday = parseDay(cursor);
    const month = monday.getMonth();
    const monthLabel = month === previousMonth ? null : `${month + 1}月`;
    previousMonth = month;
    weeks.push({ cells, monthLabel });
    cursor = addDays(cursor, 7);
  }

  return { weeks, thresholds };
}

export type RangeMode = 'last12m' | 'year';

/**
 * 产品首个发布年份。总览的年份选项从这里起算——
 * 不逐年写死列表，2026 只显示 2026，2027 显示 2027 + 2026，之后依次增加。
 */
export const LAUNCH_YEAR = 2026;

/** 可选年份（降序）：今年 → 发布年。时钟异常早于发布年时只给发布年。 */
export function availableYears(today: Date = new Date()): number[] {
  const latest = Math.max(today.getFullYear(), LAUNCH_YEAR);
  const years: number[] = [];
  for (let y = latest; y >= LAUNCH_YEAR; y -= 1) years.push(y);
  return years;
}

/** 近 12 个月（含今天，共 365 天）/ 某个自然年。 */
export function rangeFor(
  mode: RangeMode,
  year: number,
  today: Date = new Date(),
): { startDate: string; endDate: string } {
  if (mode === 'year') {
    return { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
  }
  const endDate = formatDay(today);
  return { startDate: addDays(endDate, -364), endDate };
}

/** 「2026年11月14日 · 周六」。 */
export function formatDateCN(iso: string): string {
  const d = parseDay(iso);
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · ${weekday}`;
}

/** tooltip / aria-label 用的短格式。 */
export function formatDateShort(iso: string): string {
  const d = parseDay(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

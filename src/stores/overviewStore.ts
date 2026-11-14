/**
 * 总览查询态（docs/10 §6.3）。
 *
 * 只负责「取数 + 选中日期」，不参与节点数据；下钻与跳转由 OverviewView 调 todoStore。
 * 侧栏徽标与总览页共用 `today`，完成任务后由 todoStore 触发一次防抖刷新。
 */
import { create } from 'zustand';

import { ipc } from '../ipc';
import type { AppError, DayDetailItem, OverviewResponse, OverviewScope } from '../ipc/types';
import { availableYears, formatDay, rangeFor, type RangeMode } from '../lib/heatmap';

interface OverviewState {
  response: OverviewResponse | null;
  detail: DayDetailItem[];
  selectedDate: string | null;
  loading: boolean;
  detailLoading: boolean;
  error: string | null;
  range: RangeMode;
  year: number;
  scope: OverviewScope;
  /** 今天的叶子完成数（侧栏徽标）。 */
  today: number;

  load: () => Promise<void>;
  selectDate: (date: string) => Promise<void>;
  setRange: (range: RangeMode) => void;
  setYear: (year: number) => void;
  setScope: (scope: OverviewScope) => void;
  refreshToday: () => Promise<void>;
  scheduleTodayRefresh: () => void;
}

function errMsg(e: unknown): string {
  const ae = e as Partial<AppError> | undefined;
  if (ae && typeof ae.message === 'string' && ae.message) return ae.message;
  return '数据读取失败';
}

let loadSeq = 0;
let detailSeq = 0;
let todayTimer: ReturnType<typeof setTimeout> | null = null;

export const useOverviewStore = create<OverviewState>((set, get) => ({
  response: null,
  detail: [],
  selectedDate: null,
  loading: false,
  detailLoading: false,
  error: null,
  range: 'last12m',
  year: availableYears()[0],
  scope: { kind: 'all' },
  today: 0,

  async load() {
    const seq = ++loadSeq;
    const { range, year, scope } = get();
    const { startDate, endDate } = rangeFor(range, year);
    set({ loading: true, error: null });
    try {
      const response = await ipc.getOverview({ startDate, endDate, scope });
      if (seq !== loadSeq) return;
      const todayIso = formatDay(new Date());
      const fallback =
        todayIso >= startDate && todayIso <= endDate ? todayIso : endDate;
      const selectedDate = get().selectedDate ?? fallback;
      set({
        response,
        loading: false,
        today: response.todayLeafDone,
        selectedDate,
      });
      await get().selectDate(selectedDate);
    } catch (e) {
      if (seq !== loadSeq) return;
      console.error('getOverview failed:', e);
      set({ loading: false, error: errMsg(e) });
    }
  },

  async selectDate(date) {
    const token = ++detailSeq;
    set({ selectedDate: date, detailLoading: true });
    try {
      const detail = await ipc.getOverviewDay(date, get().scope);
      if (token !== detailSeq) return;
      set({ detail, detailLoading: false });
    } catch (e) {
      if (token !== detailSeq) return;
      console.error('getOverviewDay failed:', e);
      set({ detail: [], detailLoading: false });
    }
  },

  setRange(range) {
    set({ range, selectedDate: null });
    void get().load();
  },

  setYear(year) {
    set({ range: 'year', year, selectedDate: null });
    void get().load();
  },

  setScope(scope) {
    set({ scope });
    void get().load();
  },

  async refreshToday() {
    try {
      set({ today: await ipc.getOverviewToday() });
    } catch (e) {
      console.error('getOverviewToday failed:', e);
    }
  },

  scheduleTodayRefresh() {
    if (todayTimer) clearTimeout(todayTimer);
    todayTimer = setTimeout(() => {
      todayTimer = null;
      void get().refreshToday();
    }, 400);
  },
}));

/**
 * AI Agent 运行态（docs/06 v2 §9）：复制 Prompt、执行状态、验收。
 * 节点数据仍以 todoStore 的快照为准；这里只持运行相关 UI 状态。
 * push 方向的派发 / 日志流 / Agent 探测已随 v2 移除。
 */
import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';

import { ipc } from '../ipc';
import type { AppError, RunView } from '../ipc/types';
import { useTodoStore } from './todoStore';

interface RunState {
  runs: RunView[];
  /** 右侧面板：详情 / 执行 */
  detailNodeId: string | null;
  activeRunId: string | null;

  loadRuns: () => Promise<void>;
  openDetail: (id: string | null) => void;
  openRun: (runId: string | null) => void;
  /** 复制 Prompt 并写入剪贴板（原生剪贴板优先，浏览器 API 兜底）。 */
  copyPrompt: (nodeIds: string[], variant: 'plain' | 'receipt') => Promise<boolean>;
  /** running 卡死时的手动收口（「标记结束」）。 */
  closeRun: (runId: string) => Promise<void>;
  accept: (runId: string, nodeIds: string[]) => Promise<void>;
  reject: (runId: string, nodeIds: string[], feedback: string) => Promise<void>;
  acceptNode: (nodeId: string) => Promise<void>;
  dismissNode: (nodeId: string) => Promise<void>;
}

function errMsg(e: unknown, fallback: string): string {
  const ae = e as Partial<AppError> | undefined;
  return ae?.message || fallback;
}

let listening = false;

export const useRunStore = create<RunState>((set, get) => ({
  runs: [],
  detailNodeId: null,
  activeRunId: null,

  async loadRuns() {
    try {
      set({ runs: await ipc.listRuns() });
    } catch (e) {
      console.error('listRuns failed', e);
    }
  },

  openDetail(id) {
    set({ detailNodeId: id });
  },

  openRun(runId) {
    set({ activeRunId: runId, detailNodeId: null });
  },

  async copyPrompt(nodeIds, variant) {
    const st = useTodoStore.getState();
    try {
      const result = await ipc.copyPrompt(nodeIds, variant);
      // 原生剪贴板优先（WebView2 里 navigator.clipboard 不可靠），失败再走浏览器 API。
      try {
        await ipc.copyText(result.prompt);
      } catch {
        await navigator.clipboard.writeText(result.prompt);
      }
      const lines = result.prompt.split('\n').length;
      const label = variant === 'receipt' ? '带回执' : '纯文本';
      const suffix = result.reused ? ' · 复用上一轮' : '';
      st.showToast(`Prompt 已复制（${label}）· ${lines} 行${suffix}`);
      if (variant === 'receipt') {
        await get().loadRuns();
      }
      return true;
    } catch (e) {
      st.showToast(errMsg(e, '复制失败'));
      return false;
    }
  },

  async closeRun(runId) {
    try {
      await ipc.closeRun(runId);
      await useTodoStore.getState().loadTree();
      await get().loadRuns();
      useTodoStore.getState().showToast('已标记结束');
    } catch (e) {
      useTodoStore.getState().showToast(errMsg(e, '操作失败'));
    }
  },

  async accept(runId, nodeIds) {
    try {
      const af = await ipc.acceptRun(runId, nodeIds);
      useTodoStore.getState().applyAffected(af);
      await useTodoStore.getState().loadTree();
      await get().loadRuns();
      useTodoStore.getState().showToast('已验收，任务已勾选');
    } catch (e) {
      useTodoStore.getState().showToast(errMsg(e, '验收失败'));
    }
  },

  async reject(runId, nodeIds, feedback) {
    try {
      await ipc.rejectRun(runId, nodeIds, feedback);
      await useTodoStore.getState().loadTree();
      await get().loadRuns();
      useTodoStore.getState().showToast('已驳回，反馈已写回备注');
    } catch (e) {
      useTodoStore.getState().showToast(errMsg(e, '驳回失败'));
    }
  },

  async acceptNode(nodeId) {
    try {
      const af = await ipc.acceptNode(nodeId);
      useTodoStore.getState().applyAffected(af);
      await useTodoStore.getState().loadTree();
    } catch (e) {
      useTodoStore.getState().showToast(errMsg(e, '验收失败'));
    }
  },

  async dismissNode(nodeId) {
    try {
      const af = await ipc.dismissNode(nodeId);
      useTodoStore.getState().applyAffected(af);
    } catch (e) {
      useTodoStore.getState().showToast(errMsg(e, '操作失败'));
    }
  },
}));

/** 全局只注册一次事件监听（App 启动时调用）。 */
export function initRunEvents(): () => void {
  if (listening) return () => {};
  listening = true;
  // MCP start / complete / 收口 / 验收都会推 run:status。
  const pending = [
    listen<{ runId: string; reason: string }>('run:status', () => {
      void useRunStore.getState().loadRuns();
      void useTodoStore.getState().loadTree();
    }),
  ].map(p => p.catch(() => () => {}));

  return () => {
    for (const p of pending) void p.then(unlisten => unlisten());
    listening = false;
  };
}

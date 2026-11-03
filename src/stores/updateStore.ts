/**
 * 自动更新状态机（docs/08）。
 *
 * 三条入口（启动自动检查 / 侧边栏版本号 / 系统菜单）共用这里：
 * - 自动检查失败必须静默，不能打扰用户（地区网络无法访问 GitHub 是常态）；
 * - 手动检查无更新 → toast「已是最新版本」；
 * - macOS 本轮不做签名公证，安装降级为「打开下载页」。
 */
import { create } from 'zustand';

import { ipc } from '../ipc';
import { updaterIpc, type DownloadProgress, type UpdateInfo } from '../ipc/update';
import { useTodoStore } from './todoStore';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'error';

/** macOS：未签名包无法可靠地原地替换，改为引导到 Release 下载页。 */
export const IS_MACOS =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

const DOWNLOAD_PAGE = 'https://github.com/Jeysin/tree-todo/releases/latest';

interface UpdateState {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  progress: DownloadProgress;
  error: string | null;
  dialogOpen: boolean;
  /** 本次会话已点过「稍后」；手动入口仍可重新打开。 */
  dismissed: boolean;

  check: (opts: { manual: boolean }) => Promise<void>;
  install: () => Promise<void>;
  openDownloadPage: () => Promise<void>;
  openDialog: () => void;
  closeDialog: () => void;
}

const IDLE_PROGRESS: DownloadProgress = { downloaded: 0, total: null };

/** 把插件抛出的英文错误收敛成用户能看懂的一句话（原文只进 console）。 */
function friendlyError(e: unknown): string {
  const raw = typeof e === 'string' ? e : e instanceof Error ? e.message : '';
  if (/signature|minisign|verify/i.test(raw)) return '安装包校验失败，已取消更新';
  if (/network|request|fetch|connect|timed? ?out|timeout|dns|unreachable/i.test(raw)) {
    return '网络连接失败';
  }
  return raw || '未知错误';
}

/** 同一时刻只允许一个检查请求（自动 + 手动撞车时复用）。 */
let inFlight: Promise<void> | null = null;

export const useUpdateStore = create<UpdateState>((set, get) => ({
  phase: 'idle',
  info: null,
  progress: IDLE_PROGRESS,
  error: null,
  dialogOpen: false,
  dismissed: false,

  check: async ({ manual }) => {
    const { phase, info } = get();

    // 已有更新：不重复联网，直接重开弹窗。
    if (phase === 'available' && info) {
      set({ dialogOpen: true, dismissed: false });
      return;
    }
    // 正在下载 / 安装：打开弹窗看进度，不打断。
    if (phase === 'downloading' || phase === 'installing') {
      set({ dialogOpen: true });
      return;
    }
    if (phase === 'checking') {
      return inFlight ?? undefined;
    }
    // 开发模式没有安装包，检查会得到无法安装的假更新。
    if (!import.meta.env.PROD) {
      if (manual) useTodoStore.getState().showToast('开发模式不检查更新');
      return;
    }

    set({ phase: 'checking', error: null });
    const task = (async () => {
      try {
        const next = await updaterIpc.check();
        if (!next) {
          set({ phase: 'idle', info: null, progress: IDLE_PROGRESS, dialogOpen: false });
          if (manual) useTodoStore.getState().showToast('已是最新版本');
          return;
        }
        set({
          phase: 'available',
          info: next,
          dialogOpen: true,
          dismissed: false,
          progress: IDLE_PROGRESS,
        });
      } catch (e) {
        // 自动检查失败：只留日志，不弹窗、不 toast。
        console.warn('[update] 检查更新失败', e);
        set({ phase: 'idle', info: null, error: null, dialogOpen: false });
        if (manual) {
          useTodoStore.getState().showToast('检查更新失败，请检查网络后重试');
        }
      } finally {
        inFlight = null;
      }
    })();
    inFlight = task;
    await task;
  },

  install: async () => {
    const { phase, info } = get();
    if (!info) return;

    // macOS：本轮不做签名/公证，原地安装不可靠 → 打开下载页。
    if (IS_MACOS) {
      await get().openDownloadPage();
      return;
    }
    if (phase !== 'available' && phase !== 'error') return;

    set({
      phase: 'downloading',
      dialogOpen: true,
      error: null,
      progress: { downloaded: 0, total: null },
    });

    try {
      await updaterIpc.install(p => set({ progress: p }));
      set({ phase: 'installing' });
      await updaterIpc.relaunch();
    } catch (e) {
      console.warn('[update] 下载或安装失败', e);
      set({ phase: 'error', error: friendlyError(e) });
    }
  },

  openDownloadPage: async () => {
    try {
      await ipc.openPath(DOWNLOAD_PAGE);
      set({ dialogOpen: false });
      // macOS 不会再安装，释放检查时持有的原生资源。
      await updaterIpc.dispose();
    } catch (e) {
      console.warn('[update] 打开下载页失败', e);
      set({ phase: 'error', error: '无法打开浏览器，请手动访问 GitHub Releases' });
    }
  },

  openDialog: () => {
    if (get().info) set({ dialogOpen: true, dismissed: false });
  },

  closeDialog: () => {
    if (get().phase === 'installing') return;
    set({ dialogOpen: false, dismissed: get().phase === 'available' });
  },
}));

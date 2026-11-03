/**
 * 自动更新（docs/08）：Tauri updater 的唯一前端出口。
 *
 * 约定（AGENTS.md）：插件调用与 invoke 一样收敛在 src/ipc/ 下，组件与 store 不直接
 * import 插件 API。这里同时持有 check() 返回的 Update 句柄，供后续下载安装复用。
 */
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';

/** 弹窗展示所需的更新信息（已从插件对象上摘下来，避免 UI 持有原生资源）。 */
export interface UpdateInfo {
  /** 最新版本 */
  version: string;
  /** 当前运行版本 */
  currentVersion: string;
  /** 版本介绍（release-notes 正文） */
  notes: string;
  /** 发布时间（RFC 3339） */
  date?: string;
}

export interface DownloadProgress {
  downloaded: number;
  /** 服务端未给 content-length 时为 null */
  total: number | null;
}

let pending: Update | null = null;

/** 释放上一次检查持有的原生资源（未安装就关闭弹窗 / 重新检查时）。 */
async function clearPending(): Promise<void> {
  const old = pending;
  pending = null;
  if (old) {
    try {
      await old.close();
    } catch {
      // 资源已释放或已被安装消费，忽略。
    }
  }
}

export const updaterIpc = {
  /**
   * 检查更新。无更新返回 null。
   * 网络不可达由调用方决定是否提示（自动检查必须静默）。
   */
  async check(): Promise<UpdateInfo | null> {
    const next = await check({ timeout: 15000 });
    await clearPending();
    if (!next) return null;
    pending = next;
    return {
      version: next.version,
      currentVersion: next.currentVersion,
      notes: next.body ?? '',
      date: next.date,
    };
  },

  /** 下载并安装已检查到的版本。 */
  async install(onProgress: (p: DownloadProgress) => void): Promise<void> {
    const update = pending;
    if (!update) throw new Error('没有待安装的更新，请重新检查');

    let downloaded = 0;
    let total: number | null = null;

    await update.downloadAndInstall((event: DownloadEvent) => {
      switch (event.event) {
        case 'Started':
          total = event.data.contentLength ?? null;
          onProgress({ downloaded, total });
          break;
        case 'Progress':
          downloaded += event.data.chunkLength;
          onProgress({ downloaded, total });
          break;
        case 'Finished':
          onProgress({ downloaded: total ?? downloaded, total });
          break;
      }
    });

    pending = null;
  },

  /** 安装完成后重启（Windows 安装时进程已被安装器退出，不会走到这里）。 */
  async relaunch(): Promise<void> {
    await relaunch();
  },

  /** 放弃本次更新（macOS 打开下载页后调用，避免原生资源常驻）。 */
  async dispose(): Promise<void> {
    await clearPending();
  },
};

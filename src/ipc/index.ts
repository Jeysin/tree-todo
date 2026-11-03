/**
 * Tauri command 的唯一前端出口（AGENTS.md：组件内禁止裸调 invoke）。
 * 命令参数使用 camelCase，由 Tauri 2 自动映射 Rust 侧 snake_case。
 */
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';

import type {
  Affected,
  AppSettings,
  CopyResult,
  CreateResult,
  DocIndex,
  DocMeta,
  ExecCounts,
  FolderMeta,
  ImportResult,
  McpConfig,
  RunView,
  TodoNode,
  TrashItem,
} from './types';

export const ipc = {
  /** 全量树（启动加载一次，此后靠变更快照增量合并）。 */
  getTree: (): Promise<TodoNode[]> => invoke('get_tree'),

  /** 创建节点；parentId 为 null 时创建根；position 用于“插入为兄弟”保持顺序。 */
  createNode: (
    parentId: string | null,
    content: string,
    position: number | null = null,
  ): Promise<CreateResult> =>
    invoke('create_node', { parentId, content, position }),

  /** 编辑内容（E1：不触发状态变化）。 */
  updateContent: (id: string, content: string): Promise<Affected> =>
    invoke('update_content', { id, content }),

  /** 切换状态：pending→完成(级联)，done→取消(级联)。 */
  toggleStatus: (id: string): Promise<Affected> => invoke('toggle_status', { id }),

  /** 删除节点（级联删除子孙）。 */
  deleteNode: (id: string): Promise<Affected> => invoke('delete_node', { id }),

  /** 折叠/展开（持久化）。 */
  setCollapsed: (id: string, collapsed: boolean): Promise<Affected> =>
    invoke('set_collapsed', { id, collapsed }),

  /** 批量展开（平铺视图跳转定位用）。 */
  expandNodes: (ids: string[]): Promise<Affected> => invoke('expand_nodes', { ids }),

  /** 编辑备注（E1：不触发状态变化）。 */
  updateNote: (id: string, note: string): Promise<Affected> =>
    invoke('update_note', { id, note }),

  /** 移动节点（MV1）：position 为 null 时追加到新父末尾；防环由 Rust 校验。 */
  moveNode: (id: string, newParentId: string | null, position: number | null): Promise<Affected> =>
    invoke('move_node', { id, newParentId, position }),

  /** 折叠/展开全部（视图操作，不入撤销历史）。 */
  collapseAll: (collapsed: boolean): Promise<Affected> => invoke('collapse_all', { collapsed }),

  /** 撤销 / 重做（无历史时返回 null）。 */
  undo: (): Promise<Affected | null> => invoke('undo'),
  redo: (): Promise<Affected | null> => invoke('redo'),

  // ── 导出 / 导入（v0.5：以文档 / 目录 / 全部为单位，导入即整体还原）──
  /** 导出单个文档到指定路径。 */
  exportDocument: (id: string, path: string): Promise<void> =>
    invoke('export_document', { id, path }),
  /** 导出整个目录（含子目录与其中所有文档）。 */
  exportFolder: (id: string, path: string): Promise<void> => invoke('export_folder', { id, path }),
  /** 导出全部文档与目录。 */
  exportAll: (path: string): Promise<void> => invoke('export_all', { path }),
  /** 导入导出包，整体还原为新的文档 / 目录；folderId 指定落在哪个目录下。 */
  importBundle: (path: string, folderId: string | null): Promise<ImportResult> =>
    invoke('import_bundle', { path, folderId }),

  // ── 回收站（v0.6：文档或整个目录）──
  listTrash: (): Promise<TrashItem[]> => invoke('list_trash'),
  restoreTrash: (id: string): Promise<DocIndex> => invoke('restore_trash', { id }),
  purgeTrash: (id: string): Promise<DocIndex> => invoke('purge_trash', { id }),
  emptyTrash: (): Promise<DocIndex> => invoke('empty_trash'),

  // ── 多文档 / 目录（v0.3 / v0.5）──
  listDocuments: (): Promise<DocIndex> => invoke('list_documents'),
  createDocument: (name: string, folderId: string | null): Promise<DocMeta> =>
    invoke('create_document', { name, folderId }),
  renameDocument: (id: string, name: string): Promise<DocMeta> =>
    invoke('rename_document', { id, name }),
  deleteDocument: (id: string): Promise<DocIndex> => invoke('delete_document', { id }),
  createFolder: (name: string, parentId: string | null): Promise<FolderMeta> =>
    invoke('create_folder', { name, parentId }),
  renameFolder: (id: string, name: string): Promise<FolderMeta> =>
    invoke('rename_folder', { id, name }),
  /** 把文档移动到目录并指定同级位置（folderId = null 表示根层级；position = null 表示置顶）。 */
  moveDocument: (
    id: string,
    folderId: string | null,
    position: number | null = null,
  ): Promise<DocMeta> => invoke('move_document', { id, folderId, position }),
  /** 把目录移动到另一个目录并指定同级位置（parentId = null 表示根层级；禁止移进自身子树）。 */
  moveFolder: (
    id: string,
    parentId: string | null,
    position: number | null = null,
  ): Promise<FolderMeta> => invoke('move_folder', { id, parentId, position }),
  /** 应用设置（回收站保留天数等）。 */
  getSettings: (): Promise<AppSettings> => invoke('get_settings'),
  /** 修改回收站保留天数（0 = 不自动清理），并立即清理过期条目。 */
  setTrashRetentionDays: (days: number): Promise<AppSettings> =>
    invoke('set_trash_retention_days', { days }),
  /** 应用版本号（用于左上角展示）。 */
  getAppVersion: (): Promise<string> => getVersion(),
  deleteFolder: (id: string): Promise<DocIndex> => invoke('delete_folder', { id }),
  switchDocument: (id: string): Promise<void> => invoke('switch_document', { id }),
  getCurrentDocument: (): Promise<DocMeta> => invoke('get_current_document'),

  // ── AI Agent 协同（docs/06 v2：手动粘贴 + MCP 回执）──
  /** 复制 Prompt。variant = 'plain'（纯文本）| 'receipt'（带回执，建 dispatched run）。 */
  copyPrompt: (nodeIds: string[], variant: 'plain' | 'receipt'): Promise<CopyResult> =>
    invoke('copy_prompt', { nodeIds, variant }),
  /** 预览 Prompt（无副作用）。 */
  previewPrompt: (nodeIds: string[], variant: 'plain' | 'receipt'): Promise<string> =>
    invoke('preview_prompt', { nodeIds, variant }),
  listRuns: (): Promise<RunView[]> => invoke('list_runs'),
  getRun: (runId: string): Promise<RunView> => invoke('get_run', { runId }),
  /** running 卡死时的手动收口（「标记结束」）。 */
  closeRun: (runId: string, reason?: string): Promise<void> =>
    invoke('close_run', { runId, reason: reason ?? null }),
  acceptRun: (runId: string, nodeIds: string[]): Promise<Affected> =>
    invoke('accept_run', { runId, nodeIds }),
  rejectRun: (runId: string, nodeIds: string[], feedback: string): Promise<void> =>
    invoke('reject_run', { runId, nodeIds, feedback }),
  acceptNode: (nodeId: string): Promise<Affected> => invoke('accept_node', { nodeId }),
  dismissNode: (nodeId: string): Promise<Affected> => invoke('dismiss_node', { nodeId }),
  execCounts: (): Promise<ExecCounts> => invoke('exec_counts'),
  listPendingReviews: (): Promise<RunView[]> => invoke('list_pending_reviews'),
  purgeRuns: (beforeDays: number): Promise<number> => invoke('purge_runs', { beforeDays }),
  openPath: (path: string): Promise<void> => invoke('open_path', { path }),
  copyText: (text: string): Promise<void> => invoke('copy_text', { text }),
  /** MCP 服务配置（端口 / token / URL）。 */
  getMcpConfig: (): Promise<McpConfig> => invoke('get_mcp_config'),
  /** 重置 MCP token（重置后需更新 Agent 侧配置）。 */
  resetMcpToken: (): Promise<McpConfig> => invoke('reset_mcp_token'),
};

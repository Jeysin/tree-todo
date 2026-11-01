/**
 * Tauri command 的唯一前端出口（AGENTS.md：组件内禁止裸调 invoke）。
 * 命令参数使用 camelCase，由 Tauri 2 自动映射 Rust 侧 snake_case。
 */
import { invoke } from '@tauri-apps/api/core';

import type { Affected, CreateResult, TodoNode } from './types';

export const ipc = {
  /** 全量树（启动加载一次，此后靠变更快照增量合并）。 */
  getTree: (): Promise<TodoNode[]> => invoke('get_tree'),

  /** 创建节点；parentId 为 null 时创建根。 */
  createNode: (parentId: string | null, content: string): Promise<CreateResult> =>
    invoke('create_node', { parentId, content }),

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

  /** 导出全量数据到指定路径。 */
  exportJson: (path: string): Promise<void> => invoke('export_json', { path }),

  /** 从指定路径导入（追加 + id 重映射 + 状态校正）。 */
  importJson: (path: string): Promise<Affected> => invoke('import_json', { path }),
};

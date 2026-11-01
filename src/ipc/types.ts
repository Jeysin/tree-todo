/** 节点状态（docs/02 §2）：与 Rust 侧 NodeStatus 一一对应。 */
export type NodeStatus = 'pending' | 'done';

/** 待办节点（Rust serde camelCase 序列化）。 */
export interface TodoNode {
  id: string;
  parentId: string | null;
  content: string;
  note: string;
  status: NodeStatus;
  position: number;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  /** v0.3 软删除时间（非空 = 在回收站）。 */
  deletedAt: string | null;
  /** v0.3 完成时间（统计用；pending 时为 null）。 */
  completedAt: string | null;
}

/** 变更类 command 的统一返回（docs/01 D6：受影响快照）。 */
export interface Affected {
  upserted: TodoNode[];
  removed: string[];
}

/** create_node 专属返回：额外标出新节点 id。 */
export interface CreateResult {
  newId: string;
  upserted: TodoNode[];
}

/** Rust 侧 AppError 的序列化形态（docs/01 D6：带错误码）。 */
export interface AppError {
  code: 'Db' | 'Io' | 'NodeNotFound' | 'CyclicMove' | 'ImportFormat' | 'LastDocument';
  message: string;
}

/** 回收站条目（v0.3 软删除）。 */
export interface TrashItem {
  node: TodoNode;
  descendantCount: number;
}

/** 文档元数据（v0.3 多文档）。 */
export interface DocMeta {
  id: string;
  name: string;
  createdAt: string;
}

/** 文档索引（documents.json）。 */
export interface DocIndex {
  documents: DocMeta[];
  lastOpened: string | null;
}

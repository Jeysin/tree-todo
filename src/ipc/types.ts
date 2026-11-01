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
  code: 'Db' | 'Io' | 'NodeNotFound' | 'CyclicMove';
  message: string;
}

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
  /** 旧版节点软删除字段；v0.4 起节点删除是物理删除，该值恒为 null。 */
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
  code:
    | 'Db'
    | 'Io'
    | 'NodeNotFound'
    | 'CyclicMove'
    | 'ImportFormat'
    | 'LastDocument'
    | 'RootProtected';
  message: string;
}

/** 回收站文档（v0.4：回收对象是文档，节点删除不再进回收站）。 */
export interface TrashDoc {
  id: string;
  name: string;
  createdAt: string;
  deletedAt: string;
}

/** 回收站列表项（v0.6：文档与整个目录混合展示）。 */
export interface TrashItem {
  id: string;
  kind: 'doc' | 'folder';
  name: string;
  createdAt: string;
  deletedAt: string;
  /** 目录条目携带的文档数；文档条目为 1。 */
  documentCount: number;
  /** 目录条目的子目录数（不含自身）；文档条目为 0。 */
  folderCount: number;
}

/** 文档元数据（v0.3 多文档；v0.5 起支持目录层级）。 */
export interface DocMeta {
  id: string;
  name: string;
  /** 所属目录 id；null 表示位于根层级。 */
  folderId: string | null;
  createdAt: string;
}

/** 目录元数据（v0.5）：可嵌套，只存在于 documents.json 索引里。 */
export interface FolderMeta {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

/** 文档索引（documents.json）。 */
export interface DocIndex {
  documents: DocMeta[];
  folders: FolderMeta[];
  lastOpened: string | null;
  trash: TrashDoc[];
}

/** 导入结果（v0.5：整体还原为新的文档 / 目录）。 */
export interface ImportResult {
  documentIds: string[];
  folderIds: string[];
  firstDocumentId: string | null;
}

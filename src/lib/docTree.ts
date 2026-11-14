/**
 * 文档树的共享构造（docs/10 §7.1）：把 documents / folders 两个扁平索引还原成
 * 「目录 + 文档」混排的树，供 DocPicker 这类选择器复用。
 *
 * 排序规则与侧栏完全一致（position → 目录优先 → 创建时间 → 名称）：
 * 同一个目录在侧栏与选择器里的顺序必须相同，否则用户会怀疑自己点错了。
 */
import type { DocMeta, FolderMeta } from '../ipc/types';

export type DocTreeKind = 'folder' | 'doc';

/** 同级排序所需的字段（目录与文档共享 position 坐标）。 */
export interface DocTreeSibling {
  kind: DocTreeKind;
  position: number;
  createdAt: string;
  name: string;
}

export type DocTreeNode =
  | {
      kind: 'folder';
      id: string;
      name: string;
      /** 该目录下（含子目录）的文档总数。 */
      documentCount: number;
      children: DocTreeNode[];
    }
  | { kind: 'doc'; id: string; name: string; doc: DocMeta };

/** 同级排序：position 冲突（旧数据）时目录在前，再按创建时间与名称。 */
export function compareDocSiblings(a: DocTreeSibling, b: DocTreeSibling): number {
  if (a.position !== b.position) return a.position - b.position;
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
  return a.name.localeCompare(b.name);
}

/**
 * 构造整棵文档树。两处健壮性处理：
 * - 父目录不存在的条目（索引被手工改过 / 迁移残留）提升到根，而不是整条消失；
 * - 目录自引用或成环时用 seen 拦住，避免死循环。
 */
export function buildDocTree(documents: DocMeta[], folders: FolderMeta[]): DocTreeNode[] {
  interface Entry {
    node: DocTreeNode;
    kind: DocTreeKind;
    position: number;
    createdAt: string;
    name: string;
  }

  const folderIds = new Set(folders.map(f => f.id));
  const byParent = new Map<string | null, Entry[]>();
  const push = (parentId: string | null, entry: Entry) => {
    const list = byParent.get(parentId);
    if (list) list.push(entry);
    else byParent.set(parentId, [entry]);
  };

  for (const f of folders) {
    const parent = f.parentId && folderIds.has(f.parentId) ? f.parentId : null;
    push(parent, {
      kind: 'folder',
      position: f.position,
      createdAt: f.createdAt,
      name: f.name,
      node: { kind: 'folder', id: f.id, name: f.name, documentCount: 0, children: [] },
    });
  }
  for (const d of documents) {
    const parent = d.folderId && folderIds.has(d.folderId) ? d.folderId : null;
    push(parent, {
      kind: 'doc',
      position: d.position,
      createdAt: d.createdAt,
      name: d.name,
      node: { kind: 'doc', id: d.id, name: d.name, doc: d },
    });
  }
  for (const list of byParent.values()) list.sort(compareDocSiblings);

  const seen = new Set<string>();
  const walk = (parentId: string | null): { nodes: DocTreeNode[]; docs: number } => {
    const nodes: DocTreeNode[] = [];
    let docs = 0;
    for (const entry of byParent.get(parentId) ?? []) {
      if (entry.node.kind === 'doc') {
        nodes.push(entry.node);
        docs += 1;
        continue;
      }
      if (seen.has(entry.node.id)) continue;
      seen.add(entry.node.id);
      const sub = walk(entry.node.id);
      nodes.push({ ...entry.node, children: sub.nodes, documentCount: sub.docs });
      docs += sub.docs;
    }
    return { nodes, docs };
  };

  return walk(null).nodes;
}

/** 目录 id → 完整路径（「个人 / 灵感碎片」）；根层目录就是自身名字。 */
export function buildFolderPathMap(folders: FolderMeta[]): Map<string, string> {
  const byId = new Map(folders.map(f => [f.id, f]));
  const paths = new Map<string, string>();

  const resolve = (id: string, guard = 0): string => {
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    const folder = byId.get(id);
    if (!folder || guard > 32) return '';
    const parent = folder.parentId ? resolve(folder.parentId, guard + 1) : '';
    const path = parent ? `${parent} / ${folder.name}` : folder.name;
    paths.set(id, path);
    return path;
  };

  for (const f of folders) resolve(f.id);
  return paths;
}

/** 按树的顺序（即侧栏顺序）展平所有文档，搜索结果的排序用它。 */
export function flattenDocTree(nodes: DocTreeNode[]): DocMeta[] {
  const out: DocMeta[] = [];
  const walk = (list: DocTreeNode[]) => {
    for (const node of list) {
      if (node.kind === 'doc') out.push(node.doc);
      else walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** 从根到该文档所在目录的祖先目录 id 链（用于展开定位）；根层文档返回空数组。 */
export function folderChainOf(folderId: string | null, folders: FolderMeta[]): string[] {
  if (!folderId) return [];
  const byId = new Map(folders.map(f => [f.id, f]));
  const chain: string[] = [];
  let cursor: string | null = folderId;
  for (let guard = 0; cursor && guard < 32; guard += 1) {
    const folder = byId.get(cursor);
    if (!folder) break;
    chain.unshift(folder.id);
    cursor = folder.parentId;
  }
  return chain;
}

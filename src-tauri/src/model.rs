use serde::{Deserialize, Serialize};

/// 节点状态（docs/02 §2）：仅两值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeStatus {
    Pending,
    Done,
}

impl NodeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            NodeStatus::Pending => "pending",
            NodeStatus::Done => "done",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "done" => NodeStatus::Done,
            _ => NodeStatus::Pending,
        }
    }
}

/// 节点（docs/02 §1.2）：序列化为 camelCase 供前端消费。
///
/// v0.3 新增：
/// - `deleted_at`：旧版节点软删除字段（v0.4 起回收站改为文档级，该字段保留兼容、恒为空）。
/// - `completed_at`：完成时间（统计面板"最近 7 天完成"，随 status 变更维护）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub parent_id: Option<String>,
    pub content: String,
    pub note: String,
    pub status: NodeStatus,
    pub position: f64,
    pub collapsed: bool,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub completed_at: Option<String>,
}

/// 变更类 command 的统一返回（docs/01 D6：受影响快照）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Affected {
    pub upserted: Vec<Node>,
    pub removed: Vec<String>,
}

/// create_node 专属返回：需要额外标出新建节点的 id（前端创建后立即选中并进入编辑态）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResult {
    pub new_id: String,
    pub upserted: Vec<Node>,
}

/// 回收站文档：被删除的文档元数据 + 删除时间。
/// 回收站只回收文档，节点删除是物理删除（可用撤销历史恢复）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashDoc {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub deleted_at: String,
}

/// 文档元数据（docs/05 M3 多文档：每个文档一个独立 SQLite 文件）。
/// v0.5 起支持目录层级：`folder_id` 指向所属目录，None 表示位于根层级。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocMeta {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub folder_id: Option<String>,
    pub created_at: String,
}

/// 目录元数据（v0.5 侧边栏层级结构）：目录只存在于索引里，可嵌套。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMeta {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub created_at: String,
}

/// 文档索引（app_data_dir/documents.json）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocIndex {
    pub documents: Vec<DocMeta>,
    /// v0.5 新增：目录列表；旧版索引没有该字段，default 保证兼容读取。
    #[serde(default)]
    pub folders: Vec<FolderMeta>,
    pub last_opened: Option<String>,
    /// 旧版索引没有该字段，使用 default 保证兼容读取。
    #[serde(default)]
    pub trash: Vec<TrashDoc>,
    /// v0.6：被删除的目录（连同结构与文档），恢复时整体还原。
    #[serde(default)]
    pub trash_folders: Vec<TrashFolder>,
}

/// 回收站里的目录条目：保留整套目录结构与文档元数据（含原始 id 与父子关系）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashFolder {
    pub id: String,
    pub name: String,
    pub deleted_at: String,
    pub folders: Vec<FolderMeta>,
    pub documents: Vec<DocMeta>,
}

/// 回收站列表项：统一「文档」与「目录」两种条目供前端渲染。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    /// "doc" | "folder"
    pub kind: String,
    pub name: String,
    pub created_at: String,
    pub deleted_at: String,
    /// 目录条目：包含的文档数；文档条目固定为 1。
    pub document_count: usize,
    /// 目录条目：子目录数（不含自身）；文档条目为 0。
    pub folder_count: usize,
}

/// 导入/导出文件的节点格式（docs/02 §5：JSON 字段为 snake_case）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportNode {
    pub id: String,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub note: String,
    #[serde(default = "default_status_pending")]
    pub status: String,
    #[serde(default = "default_position")]
    pub position: f64,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    /// v0.3 起导出（旧文件缺省为 None，统计会视为未知完成时间）。
    #[serde(default)]
    pub completed_at: Option<String>,
}

fn default_status_pending() -> String {
    "pending".to_string()
}
fn default_position() -> f64 {
    1024.0
}

impl From<&Node> for ImportNode {
    fn from(n: &Node) -> Self {
        ImportNode {
            id: n.id.clone(),
            parent_id: n.parent_id.clone(),
            content: n.content.clone(),
            note: n.note.clone(),
            status: n.status.as_str().to_string(),
            position: n.position,
            collapsed: n.collapsed,
            created_at: n.created_at.clone(),
            updated_at: n.updated_at.clone(),
            completed_at: n.completed_at.clone(),
        }
    }
}

impl ImportNode {
    pub fn into_node(self) -> Node {
        Node {
            id: self.id,
            parent_id: self.parent_id,
            content: self.content,
            note: self.note,
            status: NodeStatus::parse(&self.status),
            position: self.position,
            collapsed: self.collapsed,
            created_at: self.created_at,
            updated_at: self.updated_at,
            deleted_at: None,
            completed_at: self.completed_at,
        }
    }
}

/// 旧版单文档导出（v1，docs/02 §5）：仅用于兼容导入旧文件。
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportDoc {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    pub nodes: Vec<ImportNode>,
}

// ── 导出包 v2（v0.5）：一次导出可能包含一棵目录树，导入即整体还原 ──

pub const BUNDLE_FORMAT: &str = "tree-todo.bundle";
pub const BUNDLE_VERSION: u32 = 2;

/// 导出包里的一个文档。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleDocument {
    pub name: String,
    pub nodes: Vec<ImportNode>,
}

/// 导出包里的一个目录（递归包含子目录与文档）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleFolder {
    pub name: String,
    #[serde(default)]
    pub folders: Vec<BundleFolder>,
    #[serde(default)]
    pub documents: Vec<BundleDocument>,
}

/// 导出包：kind = document | folder | all。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExportBundle {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub document: Option<BundleDocument>,
    #[serde(default)]
    pub folder: Option<BundleFolder>,
    /// kind = all：根层级的目录与文档。
    #[serde(default)]
    pub folders: Vec<BundleFolder>,
    #[serde(default)]
    pub documents: Vec<BundleDocument>,
}

/// 导入结果：前端据此刷新索引并切换到第一个导入的文档。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub document_ids: Vec<String>,
    pub folder_ids: Vec<String>,
    pub first_document_id: Option<String>,
}

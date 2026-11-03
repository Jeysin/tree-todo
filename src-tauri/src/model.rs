use serde::{Deserialize, Serialize};

/// 节点状态（docs/02 §2）：仅两值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeStatus {
    Pending,
    Done,
}

/// 执行状态（docs/06 §3.2）：与主状态正交，存在 nodes.exec_state 列。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExecState {
    #[default]
    None,
    Queued,
    Running,
    AwaitingReview,
    Failed,
}

impl ExecState {
    pub fn as_str(self) -> &'static str {
        match self {
            ExecState::None => "none",
            ExecState::Queued => "queued",
            ExecState::Running => "running",
            ExecState::AwaitingReview => "awaiting_review",
            ExecState::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "queued" => ExecState::Queued,
            "running" => ExecState::Running,
            "awaiting_review" => ExecState::AwaitingReview,
            "failed" => ExecState::Failed,
            _ => ExecState::None,
        }
    }
}

/// `exec_detail` JSON 的内容：只放低频明细，需要查询的字段都独立成列。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecDetail {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub reported: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

/// 节点上的执行状态 DTO（由 exec_* 列组装；state=none 时为 None）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeExecution {
    pub state: ExecState,
    pub run_id: Option<String>,
    pub agent_id: String,
    pub agent_name: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    pub needs_confirmation: bool,
    #[serde(flatten)]
    pub detail: ExecDetail,
}

/// 运行状态（docs/06 v2 §6.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// 已复制「带回执」的 Prompt，等待 Agent 调 start（节点无投影，D29）。
    #[default]
    Dispatched,
    /// push 时代的历史值（v2 不再产生，保留解析兼容）。
    Queued,
    Running,
    AwaitingReview,
    Reviewed,
    Failed,
    /// push 时代的历史值（无进程后不再产生）。
    Blocked,
    Cancelled,
    /// push 时代的历史值（无进程后不再产生）。
    Interrupted,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Dispatched => "dispatched",
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::AwaitingReview => "awaiting_review",
            RunStatus::Reviewed => "reviewed",
            RunStatus::Failed => "failed",
            RunStatus::Blocked => "blocked",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Interrupted => "interrupted",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "dispatched" => RunStatus::Dispatched,
            "queued" => RunStatus::Queued,
            "running" => RunStatus::Running,
            "awaiting_review" => RunStatus::AwaitingReview,
            "reviewed" => RunStatus::Reviewed,
            "failed" => RunStatus::Failed,
            "blocked" => RunStatus::Blocked,
            "cancelled" => RunStatus::Cancelled,
            _ => RunStatus::Interrupted,
        }
    }

    /// 是否仍未收口（未验收 / 未结束）。
    pub fn is_active(self) -> bool {
        matches!(
            self,
            RunStatus::Dispatched
                | RunStatus::Queued
                | RunStatus::Running
                | RunStatus::AwaitingReview
        )
    }
}

/// 一条运行记录（docs/06 §7.2）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub agent_id: String,
    pub agent_version: Option<String>,
    pub status: RunStatus,
    pub mode: String,
    pub needs_confirmation: bool,
    pub workspace: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub prompt: String,
    pub session_id: Option<String>,
    pub pid: Option<i64>,
    pub exit_code: Option<i64>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub cost_usd: Option<f64>,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub reviewed_at: Option<String>,
    pub dismissed_at: Option<String>,
    pub log_path: Option<String>,
}

/// run ↔ node 的关联（Agent 的 report 与用户的 review 分开）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunNode {
    pub run_id: String,
    pub node_id: String,
    pub report: String,
    pub review: String,
    pub reported_at: Option<String>,
    pub reviewed_at: Option<String>,
    pub summary: Option<String>,
    /// 前端展示用：节点标题（读取时 join，不落库）。
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    #[serde(flatten)]
    pub run: Run,
    pub nodes: Vec<RunNode>,
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
    /// 执行状态（docs/06 §3.2）：读自 exec_* 列；none 时为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<NodeExecution>,
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
    /// 侧边栏同级排序（v0.6：分数定位法，目录与文档共享坐标）。
    #[serde(default)]
    pub position: f64,
    /// v1.1：文档默认工作区（索引缓存；文档库 doc_meta 有副本）。
    #[serde(default)]
    pub workspace: Option<String>,
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
    /// 侧边栏同级排序（v0.6：分数定位法，目录与文档共享坐标）。
    #[serde(default)]
    pub position: f64,
}

/// 文档索引（app_data_dir/documents.json）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocIndex {
    /// 索引结构版本（缺失按 1 处理）。v3：侧边栏排序 + 回收站保留天数。
    #[serde(default = "default_index_schema")]
    pub schema_version: u32,
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
    /// v0.6：回收站自动清理阈值（天）；0 表示不自动清理。
    #[serde(default = "default_trash_retention_days")]
    pub trash_retention_days: u32,
    /// v0.7：「复制 Prompt」末尾「约束」段的自定义文本（全局，设置页可改）。
    /// 旧索引没有该字段，default 回落到内置默认约束。
    #[serde(default = "default_prompt_constraints")]
    pub prompt_constraints: String,
}

impl Default for DocIndex {
    fn default() -> Self {
        Self {
            schema_version: 3,
            documents: Vec::new(),
            folders: Vec::new(),
            last_opened: None,
            trash: Vec::new(),
            trash_folders: Vec::new(),
            trash_retention_days: default_trash_retention_days(),
            prompt_constraints: default_prompt_constraints(),
        }
    }
}

/// 应用设置（设置页读取 / 修改）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// 回收站自动清理阈值（天）；0 表示不自动清理。
    pub trash_retention_days: u32,
    /// 「复制 Prompt」末尾「约束」段的自定义文本（已规整，非空）。
    pub prompt_constraints: String,
    /// 内置默认约束（设置页「恢复默认」用，前端不再复刻一份文案）。
    pub default_prompt_constraints: String,
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

/// 导出文件里的执行态摘要（docs/06 §7.9；只导出 awaiting_review / failed）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImportExecution {
    pub state: String,
    #[serde(default)]
    pub agent_name: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub reported: Option<String>,
    #[serde(default)]
    pub needs_confirmation: bool,
    #[serde(default)]
    pub summary: Option<String>,
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
    /// v3：只携带终态执行摘要，不带 runId / workspace / 日志路径。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<ImportExecution>,
}

fn default_status_pending() -> String {
    "pending".to_string()
}
fn default_position() -> f64 {
    1024.0
}
fn default_index_schema() -> u32 {
    1
}
fn default_trash_retention_days() -> u32 {
    30
}
fn default_prompt_constraints() -> String {
    crate::agents::DEFAULT_PROMPT_CONSTRAINTS.to_string()
}

impl From<&Node> for ImportNode {
    fn from(n: &Node) -> Self {
        let execution = n.execution.as_ref().and_then(|e| {
            matches!(e.state, ExecState::AwaitingReview | ExecState::Failed).then(|| ImportExecution {
                state: e.state.as_str().to_string(),
                agent_name: Some(e.agent_name.clone()),
                model: e.detail.model.clone(),
                started_at: Some(e.started_at.clone()),
                finished_at: e.finished_at.clone(),
                duration_ms: e.duration_ms,
                reported: e.detail.reported.clone(),
                needs_confirmation: e.needs_confirmation,
                summary: e.detail.summary.clone(),
            })
        });
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
            execution,
        }
    }
}

impl ImportNode {
    pub fn into_node(self) -> Node {
        let execution = self.execution.map(|e| NodeExecution {
            state: ExecState::parse(&e.state),
            run_id: None,
            agent_id: "import".to_string(),
            agent_name: e.agent_name.unwrap_or_else(|| "导入".to_string()),
            started_at: e.started_at.unwrap_or_default(),
            finished_at: e.finished_at,
            duration_ms: e.duration_ms,
            needs_confirmation: e.needs_confirmation,
            detail: ExecDetail {
                model: e.model,
                workspace: None,
                reported: e.reported,
                summary: e.summary,
                source: Some("import".to_string()),
            },
        });
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
            execution,
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
pub const BUNDLE_VERSION: u32 = 3;

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

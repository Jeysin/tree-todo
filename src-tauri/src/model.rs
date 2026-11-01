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
}

/// 变更类 command 的统一返回（docs/01 D6：受影响快照）。
#[derive(Debug, Serialize)]
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

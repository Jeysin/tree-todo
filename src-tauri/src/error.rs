use serde::{ser::SerializeStruct, Serialize};

/// 统一错误类型（docs/01 D6）：带错误码，便于前端做 i18n 与分支处理。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("数据库错误: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("节点不存在: {0}")]
    NodeNotFound(String),

    /// v0.2 拖拽移动时使用：不允许把节点移动到它自己的子树内（docs/02 CC8）。
    #[error("不允许把节点移动到它自己的子树内")]
    CyclicMove,

    /// 导入文件格式错误（docs/02 §5）。
    #[error("导入文件格式错误: {0}")]
    ImportFormat(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let code = match self {
            AppError::Db(_) => "Db",
            AppError::Io(_) => "Io",
            AppError::NodeNotFound(_) => "NodeNotFound",
            AppError::CyclicMove => "CyclicMove",
            AppError::ImportFormat(_) => "ImportFormat",
        };
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", code)?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

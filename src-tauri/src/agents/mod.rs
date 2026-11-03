//! Prompt 组装（docs/06 v2 §5）：两个变体。
//!
//! - 纯文本（`plain`）：任务本体，不含任何 tree-todo 痕迹（无节点 ID、无工具名）。
//! - 带回执（`receipt`）：纯文本内容 + 节点 ID + MCP 完成协议段。
//!
//! push 方向（Agent 探测 / CLI 派发 / 流解析）已在 v2 整体移除，见 docs/06 §8。

pub mod mcp;
#[cfg(test)]
mod agent_tests;
#[cfg(test)]
mod mcp_tests;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::model::{Node, NodeStatus};

/// 构造一个最小 Node（测试与外部调用共用）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn test_node(id: &str, content: &str) -> Node {
    Node {
        id: id.to_string(),
        parent_id: None,
        content: content.to_string(),
        note: String::new(),
        status: NodeStatus::Pending,
        position: 0.0,
        collapsed: false,
        created_at: "2026-11-03T00:00:00Z".into(),
        updated_at: "2026-11-03T00:00:00Z".into(),
        deleted_at: None,
        completed_at: None,
        execution: None,
    }
}

/// Prompt 变体（docs/06 v2 §5.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptVariant {
    /// 纯文本：粘贴给任何 Agent，完成后用户手动勾选。
    Plain,
    /// 带回执：Agent 通过 MCP 工具分两阶段回报（start → complete）。
    Receipt,
}

impl PromptVariant {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "plain" => Some(PromptVariant::Plain),
            "receipt" => Some(PromptVariant::Receipt),
            _ => None,
        }
    }
}

pub struct PromptOptions<'a> {
    pub doc_name: &'a str,
    pub nodes: &'a [Node],
    pub all_nodes: &'a HashMap<String, Node>,
    pub children_of: &'a HashMap<String, Vec<String>>,
    /// 仅 receipt 变体：随 Prompt 下发的运行 ID。
    pub run_id: Option<&'a str>,
    /// 仅 receipt 变体：变体 A 不渲染节点 ID（纯文本不含 tree-todo 痕迹）。
    pub variant: PromptVariant,
}

fn truncated(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("\n（已截断）");
    out
}

fn ancestor_path(node: &Node, all: &HashMap<String, Node>) -> String {
    let mut parts = Vec::new();
    let mut cur = node.parent_id.clone();
    while let Some(id) = cur {
        let Some(n) = all.get(&id) else { break };
        parts.push(if n.content.trim().is_empty() { "未命名".to_string() } else { n.content.clone() });
        cur = n.parent_id.clone();
    }
    parts.reverse();
    parts.join(" / ")
}

fn node_block(
    idx: Option<usize>,
    node: &Node,
    opts: &PromptOptions<'_>,
    children_of: &HashMap<String, Vec<String>>,
) -> String {
    let mut s = String::new();
    match idx {
        Some(i) => s.push_str(&format!("# 任务 {i}：{}", node.content.trim())),
        None => s.push_str(&format!("# 任务：{}", node.content.trim())),
    }
    s.push('\n');
    // 节点 ID 只出现在带回执变体里：纯文本不留任何 tree-todo 痕迹（S-05 断言）。
    if opts.variant == PromptVariant::Receipt {
        s.push_str(&format!("\n节点 ID：`{}`\n", node.id));
    }

    let note = node.note.trim();
    if !note.is_empty() {
        s.push_str("\n## 补充说明\n");
        s.push_str(&truncated(note, 6000));
        s.push('\n');
    }

    s.push_str("\n## 任务上下文\n");
    s.push_str(&format!("- 文档：{}\n", opts.doc_name));
    let path = ancestor_path(node, opts.all_nodes);
    if !path.is_empty() {
        s.push_str(&format!("- 路径：{path}\n"));
    }

    let kids = children_of.get(&node.id).cloned().unwrap_or_default();
    let mut visible = 0;
    let mut buf = String::new();
    for kid in kids.iter().take(150) {
        if let Some(k) = opts.all_nodes.get(kid) {
            let mark = if k.status == NodeStatus::Done { "x" } else { " " };
            buf.push_str(&format!("- [{mark}] {}\n", k.content.trim()));
            visible += 1;
        }
    }
    if !buf.is_empty() {
        s.push_str("\n## 子任务（全部完成后本任务才算完成）\n");
        s.push_str(&buf);
        let total = kids.len();
        if total > visible {
            s.push_str(&format!("- 还有 {} 条未列出\n", total - visible));
        }
    }
    s
}

fn receipt_section(opts: &PromptOptions<'_>) -> String {
    let Some(run_id) = opts.run_id else {
        return String::new();
    };
    let mut out = String::new();

    let id_list = opts
        .nodes
        .iter()
        .map(|n| format!("- `{}` {}", n.id, n.content.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    let tasks_example = opts
        .nodes
        .iter()
        .map(|n| {
            format!(
                "{{\"id\":\"{}\",\"result\":\"done\",\"summary\":\"一句话说明\"}}",
                n.id
            )
        })
        .collect::<Vec<_>>()
        .join(",");

    out.push_str("\n## 完成协议（必须遵守）\n");
    out.push_str(&format!("运行 ID：`{run_id}`\n\n"));
    out.push_str("本次需要回执的节点：\n");
    out.push_str(&id_list);
    out.push_str("\n\n1. **开始执行前**，先调用 MCP 工具 `tree_todo_start`：\n");
    out.push_str(&format!(
        "   `{{\"run_id\":\"{run_id}\",\"agent_name\":\"<你的产品名称，如 Claude Code / Trae>\"}}`\n"
    ));
    out.push_str("   ——任务将标记为「执行中」并开始计时。\n");
    out.push_str("2. **全部完成后**，调用 MCP 工具 `tree_todo_complete_tasks`：\n");
    out.push_str(&format!(
        "   `{{\"run_id\":\"{run_id}\",\"tasks\":[{tasks_example}]}}`\n"
    ));
    out.push_str("   ——任务将进入「待验收」，是否完成由用户验收决定。\n");
    out.push_str("3. 若上述工具不可用（tree-todo 未运行或未配置其 MCP server），直接完成任务即可，无需回执。\n");
    out.push_str("4. 任何时候都不要试图替用户「完成 / 勾选」任务。\n");
    out
}

pub fn build_prompt(opts: &PromptOptions<'_>) -> String {
    let mut out = String::new();
    for (i, node) in opts.nodes.iter().enumerate() {
        if i > 0 {
            out.push_str("\n---\n\n");
        }
        out.push_str(&node_block(
            (opts.nodes.len() > 1).then_some(i + 1),
            node,
            opts,
            opts.children_of,
        ));
    }

    if opts.variant == PromptVariant::Receipt {
        out.push_str(&receipt_section(opts));
    }

    out.push_str("\n## 约束\n");
    out.push_str("- 只修改与本任务相关的文件；不要执行 `git commit` / `git push`。\n");
    out.push_str("- 不要询问确认性问题（无人值守）；把假设写在最终回复里。\n");
    out.push_str("- 完成后用不超过 5 行总结做了什么、改了哪些文件。\n");
    out
}

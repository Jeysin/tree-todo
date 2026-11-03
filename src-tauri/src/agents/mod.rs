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

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::model::{ExecState, Node, NodeStatus};

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
    /// 「约束」段的自定义文本（设置页可改）；空串回落到 `DEFAULT_PROMPT_CONSTRAINTS`。
    pub constraints: &'a str,
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

/// 同层排序键：position 优先，其次 created_at / id，保证结果与 HashMap 遍历顺序无关。
fn tree_key(a: &Node, b: &Node) -> Ordering {
    a.position
        .partial_cmp(&b.position)
        .unwrap_or(Ordering::Equal)
        .then_with(|| a.created_at.cmp(&b.created_at))
        .then_with(|| a.id.cmp(&b.id))
}

/// 全树前序索引（父先于子、兄弟按 position），供多选排序使用。
fn preorder_index(all: &HashMap<String, Node>) -> HashMap<String, usize> {
    let mut kids: HashMap<&str, Vec<&Node>> = HashMap::new();
    let mut roots: Vec<&Node> = Vec::new();
    for n in all.values() {
        match n.parent_id.as_deref() {
            Some(pid) => kids.entry(pid).or_default().push(n),
            None => roots.push(n),
        }
    }
    for v in kids.values_mut() {
        v.sort_by(|a, b| tree_key(a, b));
    }
    roots.sort_by(|a, b| tree_key(a, b));

    let mut index: HashMap<String, usize> = HashMap::with_capacity(all.len());
    let mut cursor = 0usize;
    let mut stack: Vec<&Node> = roots.into_iter().rev().collect();
    while let Some(n) = stack.pop() {
        // 脏数据（环）时避免死循环；未遍历到的节点由调用方按 usize::MAX 兜底。
        if index.contains_key(&n.id) {
            continue;
        }
        index.insert(n.id.clone(), cursor);
        cursor += 1;
        if let Some(cs) = kids.get(n.id.as_str()) {
            for c in cs.iter().rev() {
                stack.push(c);
            }
        }
    }
    index
}

/// 是否存在被选中的祖先（`selected` 只含 id）。
fn has_selected_ancestor(node: &Node, selected: &HashSet<String>, all: &HashMap<String, Node>) -> bool {
    let mut cur = node.parent_id.as_deref();
    while let Some(pid) = cur {
        if selected.contains(pid) {
            return true;
        }
        cur = all.get(pid).and_then(|p| p.parent_id.as_deref());
    }
    false
}

/// 多选归一化：去重 + 剔除「祖先已被选中」的后代 + 按树前序排列。
///
/// 多任务 Prompt 的可预测性全压在这里（docs/06 §5.2）：
/// - 后代已被祖先的「子任务」清单覆盖，再单独成段只会让 Agent 重复执行、重复回执；
/// - 段序按树前序（父先于子、兄弟按 position），与脑图从上到下的阅读顺序一致；
/// - 不信任调用方传入顺序，排序结果与前端点选先后无关。
pub fn normalize_selection(selected: &[Node], all: &HashMap<String, Node>) -> Vec<Node> {
    let mut ids: HashSet<String> = HashSet::new();
    let mut picked: Vec<&Node> = Vec::new();
    for n in selected {
        if ids.insert(n.id.clone()) {
            picked.push(n);
        }
    }
    if picked.len() > 1 {
        picked.retain(|n| !has_selected_ancestor(n, &ids, all));
    }
    let order = preorder_index(all);
    picked.sort_by_key(|n| order.get(&n.id).copied().unwrap_or(usize::MAX));
    picked.into_iter().cloned().collect()
}

/// 子任务清单的硬上限（超出只标注条数，Prompt 不无限膨胀）。
const MAX_LISTED_CHILDREN: usize = 150;

/// 「约束」段的默认文本（设置页可覆盖，docs/06 §5.1）。
///
/// 一行一条，渲染时统一加 `- ` 前缀；空行忽略。
pub const DEFAULT_PROMPT_CONSTRAINTS: &str = "\
只修改与本任务相关的文件；不要执行 `git commit` / `git push`。
不要询问确认性问题（无人值守）；把假设写在最终回复里。
完成后用不超过 5 行总结做了什么、改了哪些文件。";

/// 约束文本上限（字符）：约束是几句话，塞进一整篇文档只会挤掉任务本体。
pub const MAX_PROMPT_CONSTRAINTS_CHARS: usize = 2000;

/// 规整用户填写的约束文本：统一换行符、去掉空行与行尾空白。
///
/// 空文本一律回落到内置默认——设置页「清空后保存」等价于恢复默认，
/// 避免出现只有标题、没有任何条目的空约束段。
pub fn normalize_constraints(raw: &str) -> String {
    let text = raw.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return DEFAULT_PROMPT_CONSTRAINTS.to_string();
    }
    lines.join("\n")
}

/// 用户输入的一行规整成约束条目：去掉自己写的列表符号，避免渲染成 `- - xxx`。
fn constraint_line(raw: &str) -> Option<&str> {
    let line = raw.trim();
    if line.is_empty() {
        return None;
    }
    let line = line.trim_start_matches(['-', '*', '•', '·']).trim_start();
    (!line.is_empty()).then_some(line)
}

/// 渲染「约束」段：文本为空时回落到内置默认——约束段永远存在，
/// 自定义的只是内容，不是「有没有」。
fn constraints_section(raw: &str) -> String {
    let text = if raw.trim().is_empty() { DEFAULT_PROMPT_CONSTRAINTS } else { raw };
    let mut out = String::from("\n## 约束\n");
    for line in text.lines() {
        if let Some(line) = constraint_line(line) {
            out.push_str("- ");
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// 这个节点是否还值得写进「子任务」清单：
/// 已完成的不必再做；执行中 / 排队中 / 待验收的已有归属或已交差，列进去只会重复干活。
fn needs_work(node: &Node) -> bool {
    if node.status == NodeStatus::Done {
        return false;
    }
    !matches!(
        node.execution.as_ref().map(|e| e.state),
        Some(ExecState::Queued | ExecState::Running | ExecState::AwaitingReview)
    )
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

    // 子任务清单只列「还值得派出去干」的直接子节点：
    // 已完成的不用再做，待验收 / 执行中的已经有人在做（或已做完待验收），
    // 列进新 Prompt 只会让 Agent 重复执行、重复回执。
    let pending_kids: Vec<&Node> = children_of
        .get(&node.id)
        .map(|kids| {
            kids.iter()
                .filter_map(|kid| opts.all_nodes.get(kid))
                .filter(|k| needs_work(k))
                .collect()
        })
        .unwrap_or_default();
    if !pending_kids.is_empty() {
        s.push_str("\n## 子任务（全部完成后本任务才算完成）\n");
        for k in pending_kids.iter().take(MAX_LISTED_CHILDREN) {
            s.push_str(&format!("- [ ] {}\n", k.content.trim()));
        }
        if pending_kids.len() > MAX_LISTED_CHILDREN {
            s.push_str(&format!(
                "- 还有 {} 条未列出\n",
                pending_kids.len() - MAX_LISTED_CHILDREN
            ));
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

    out.push_str(&constraints_section(opts.constraints));
    out
}

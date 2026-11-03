//! Prompt 两变体的组装契约（docs/06 v2 §5.2）。

use std::collections::HashMap;

use super::{build_prompt, test_node, PromptOptions, PromptVariant};
use crate::model::{Node, NodeStatus};

/// 单节点夹具（避免复杂元组触发 type_complexity）。
struct Fixture {
    nodes: Vec<Node>,
    all: HashMap<String, Node>,
    children: HashMap<String, Vec<String>>,
}

impl Fixture {
    fn prompt(&self, run_id: Option<&str>, variant: PromptVariant) -> String {
        build_prompt(&PromptOptions {
            doc_name: "产品 A",
            nodes: &self.nodes,
            all_nodes: &self.all,
            children_of: &self.children,
            run_id,
            variant,
        })
    }
}

fn single() -> Fixture {
    let node = test_node("n1", "修登录偶现 500");
    let mut all = HashMap::new();
    all.insert("n1".into(), node.clone());
    Fixture {
        nodes: vec![node],
        all,
        children: HashMap::new(),
    }
}

#[test]
fn plain_variant_has_no_tree_todo_trace() {
    let fx = single();
    // 变体 A 即使误传了 run_id 也不得渲染任何回执内容。
    let prompt = fx.prompt(Some("run_x"), PromptVariant::Plain);
    assert!(!prompt.contains("节点 ID"), "纯文本不得含节点 ID");
    assert!(!prompt.contains("run_x"), "纯文本不得含运行 ID");
    assert!(!prompt.contains("tree_todo"), "纯文本不得含工具名");
    assert!(!prompt.contains("完成协议"), "纯文本不得含回执协议");
    assert!(!prompt.contains("回到 tree-todo"), "纯文本不得含指引文案");
    assert!(!prompt.contains("工作区"), "纯文本不得含工作区行");
    assert!(prompt.contains("# 任务：修登录偶现 500"));
    assert!(prompt.contains("- 文档：产品 A"));
    assert!(prompt.contains("## 约束"));
}

#[test]
fn receipt_variant_contains_protocol() {
    let fx = single();
    let prompt = fx.prompt(Some("run_x"), PromptVariant::Receipt);
    assert!(prompt.contains("节点 ID：`n1`"));
    assert!(prompt.contains("运行 ID：`run_x`"));
    assert!(prompt.contains("tree_todo_start"));
    assert!(prompt.contains("tree_todo_complete_tasks"));
    assert!(prompt.contains("完成协议（必须遵守）"));
    assert!(prompt.contains("不要试图替用户"), "验收权声明必须在协议里");
}

#[test]
fn note_empty_omitted_and_present_rendered() {
    let fx = single();
    let prompt = fx.prompt(None, PromptVariant::Plain);
    assert!(!prompt.contains("补充说明"), "note 为空时整段省略");

    let mut with_note = fx.nodes[0].clone();
    with_note.note = "Namecheap 注册 .com，预算 $15/年".into();
    let mut all = HashMap::new();
    all.insert("n1".into(), with_note.clone());
    let prompt = build_prompt(&PromptOptions {
        doc_name: "产品 A",
        nodes: std::slice::from_ref(&with_note),
        all_nodes: &all,
        children_of: &fx.children,
        run_id: None,
        variant: PromptVariant::Plain,
    });
    assert!(prompt.contains("## 补充说明"));
    assert!(prompt.contains("Namecheap"));
}

#[test]
fn note_over_limit_truncated() {
    let fx = single();
    let mut n = fx.nodes[0].clone();
    n.note = "x".repeat(7000);
    let mut all = HashMap::new();
    all.insert("n1".into(), n.clone());
    let prompt = build_prompt(&PromptOptions {
        doc_name: "产品 A",
        nodes: std::slice::from_ref(&n),
        all_nodes: &all,
        children_of: &fx.children,
        run_id: None,
        variant: PromptVariant::Plain,
    });
    assert!(prompt.contains("（已截断）"));
}

#[test]
fn multi_node_shares_one_run() {
    let a = test_node("n1", "任务一");
    let b = test_node("n2", "任务二");
    let mut all = HashMap::new();
    all.insert("n1".into(), a.clone());
    all.insert("n2".into(), b.clone());
    let fx = Fixture {
        nodes: vec![a, b],
        all,
        children: HashMap::new(),
    };
    let prompt = fx.prompt(Some("run_m"), PromptVariant::Receipt);
    assert!(prompt.contains("# 任务 1：任务一"));
    assert!(prompt.contains("# 任务 2：任务二"));
    // 共用一个 runId，tasks 协议里列出全部节点。
    assert!(prompt.matches("run_m").count() >= 3);
    assert!(prompt.contains("`n1`"));
    assert!(prompt.contains("`n2`"));
}

#[test]
fn children_listed_with_done_marks() {
    let parent = test_node("p1", "上线准备");
    let mut c1 = test_node("c1", "已做完的前置");
    c1.status = NodeStatus::Done;
    let c2 = test_node("c2", "还没做的");
    let mut all = HashMap::new();
    all.insert("p1".into(), parent.clone());
    all.insert("c1".into(), c1);
    all.insert("c2".into(), c2);
    let fx = Fixture {
        nodes: vec![parent],
        all,
        children: HashMap::from([("p1".to_string(), vec!["c1".to_string(), "c2".to_string()])]),
    };
    let prompt = fx.prompt(None, PromptVariant::Plain);
    assert!(prompt.contains("- [x] 已做完的前置"));
    assert!(prompt.contains("- [ ] 还没做的"));
    assert!(prompt.contains("## 子任务（全部完成后本任务才算完成）"));
}

#[test]
fn ancestor_path_rendered() {
    let mut root = test_node("r", "产品 A");
    root.content = "产品 A".into();
    let mut mid = test_node("m", "上线");
    mid.parent_id = Some("r".into());
    let mut leaf = test_node("l", "买域名");
    leaf.parent_id = Some("m".into());
    let mut all = HashMap::new();
    all.insert("r".into(), root);
    all.insert("m".into(), mid);
    all.insert("l".into(), leaf.clone());
    let fx = Fixture {
        nodes: vec![leaf],
        all,
        children: HashMap::new(),
    };
    let prompt = fx.prompt(None, PromptVariant::Plain);
    assert!(prompt.contains("- 路径：产品 A / 上线"));
}

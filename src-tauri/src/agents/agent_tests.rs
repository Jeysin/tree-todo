//! Prompt 两变体的组装契约（docs/06 v2 §5.2）。

use std::collections::HashMap;

use super::{
    build_prompt, normalize_selection, test_node, PromptOptions, PromptVariant,
    DEFAULT_PROMPT_CONSTRAINTS,
};
use crate::model::{ExecState, Node, NodeExecution, NodeStatus};

/// 单节点夹具（避免复杂元组触发 type_complexity）。
struct Fixture {
    nodes: Vec<Node>,
    all: HashMap<String, Node>,
    children: HashMap<String, Vec<String>>,
}

impl Fixture {
    fn prompt(&self, run_id: Option<&str>, variant: PromptVariant) -> String {
        self.prompt_with(run_id, variant, DEFAULT_PROMPT_CONSTRAINTS)
    }

    fn prompt_with(&self, run_id: Option<&str>, variant: PromptVariant, constraints: &str) -> String {
        build_prompt(&PromptOptions {
            doc_name: "产品 A",
            nodes: &self.nodes,
            all_nodes: &self.all,
            children_of: &self.children,
            run_id,
            variant,
            constraints,
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

/// 构造指定执行状态的 execution（只关心 state，其余字段无关紧要）。
fn exec(state: ExecState) -> Option<NodeExecution> {
    Some(NodeExecution {
        state,
        run_id: None,
        agent_id: String::new(),
        agent_name: "Trae".into(),
        started_at: String::new(),
        finished_at: None,
        duration_ms: None,
        needs_confirmation: false,
        detail: Default::default(),
    })
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
        constraints: DEFAULT_PROMPT_CONSTRAINTS,
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
        constraints: DEFAULT_PROMPT_CONSTRAINTS,
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
fn subtask_list_keeps_only_actionable_children() {
    let parent = test_node("p1", "上线准备");
    let mut c1 = test_node("c1", "已做完的前置");
    c1.status = NodeStatus::Done;
    let c2 = test_node("c2", "还没做的");
    let mut c3 = test_node("c3", "已完成待验收的");
    c3.execution = exec(ExecState::AwaitingReview);
    let mut c4 = test_node("c4", "别的 Agent 正在做的");
    c4.execution = exec(ExecState::Running);
    let mut c5 = test_node("c5", "上次失败的");
    c5.execution = exec(ExecState::Failed);

    let mut all = HashMap::new();
    for n in [&parent, &c1, &c2, &c3, &c4, &c5] {
        all.insert(n.id.clone(), n.clone());
    }
    let fx = Fixture {
        nodes: vec![parent],
        all,
        children: HashMap::from([(
            "p1".to_string(),
            vec!["c1".into(), "c2".into(), "c3".into(), "c4".into(), "c5".into()],
        )]),
    };
    let prompt = fx.prompt(None, PromptVariant::Plain);
    assert!(prompt.contains("## 子任务（全部完成后本任务才算完成）"));
    assert!(prompt.contains("- [ ] 还没做的"), "待处理子任务必须列出");
    assert!(prompt.contains("- [ ] 上次失败的"), "失败待重做的子任务仍要列出");
    assert!(!prompt.contains("已做完的前置"), "已完成子任务不再复制");
    assert!(!prompt.contains("已完成待验收的"), "待验收子任务不再复制");
    assert!(!prompt.contains("别的 Agent 正在做的"), "执行中的子任务不再复制");
    assert!(!prompt.contains("- [x]"), "清单里不再出现已完成标记");
}

#[test]
fn subtask_section_omitted_when_nothing_left() {
    let parent = test_node("p1", "上线准备");
    let mut c1 = test_node("c1", "已做完的");
    c1.status = NodeStatus::Done;
    let mut c2 = test_node("c2", "待验收的");
    c2.execution = exec(ExecState::AwaitingReview);
    let mut all = HashMap::new();
    for n in [&parent, &c1, &c2] {
        all.insert(n.id.clone(), n.clone());
    }
    let fx = Fixture {
        nodes: vec![parent],
        all,
        children: HashMap::from([("p1".to_string(), vec!["c1".into(), "c2".into()])]),
    };
    let prompt = fx.prompt(None, PromptVariant::Plain);
    assert!(!prompt.contains("## 子任务"), "没有可做的子任务时整段省略");
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

// ── 多选归一化（docs/06 §5.2：树序 + 祖先去重）──

fn tree_node(id: &str, content: &str, parent: Option<&str>, position: f64) -> Node {
    let mut n = test_node(id, content);
    n.parent_id = parent.map(str::to_string);
    n.position = position;
    n
}

/// 根 → A(前端) → A1/A2，根 → B(后端) → B1/B2。
fn sibling_tree() -> HashMap<String, Node> {
    [
        tree_node("root", "重构登录模块", None, 0.0),
        tree_node("a", "前端改造", Some("root"), 1024.0),
        tree_node("a1", "拆分登录表单", Some("a"), 1024.0),
        tree_node("a2", "补齐表单样式", Some("a"), 2048.0),
        tree_node("b", "后端改造", Some("root"), 2048.0),
        tree_node("b2", "增加错误码", Some("b"), 1024.0),
    ]
    .into_iter()
    .map(|n| (n.id.clone(), n))
    .collect()
}

#[test]
fn multi_select_follows_tree_order_not_selection_order() {
    let all = sibling_tree();
    // 故意乱序传入：真实选区来自 UI，点选先后不可靠。
    let selected = vec![all["b2"].clone(), all["a2"].clone(), all["a1"].clone()];
    let ordered = normalize_selection(&selected, &all);
    let ids: Vec<&str> = ordered.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, ["a1", "a2", "b2"], "兄弟按 position、父先于子");

    let prompt = build_prompt(&PromptOptions {
        doc_name: "重构登录模块",
        nodes: &ordered,
        all_nodes: &all,
        children_of: &HashMap::new(),
        run_id: Some("run_m"),
        variant: PromptVariant::Receipt,
        constraints: DEFAULT_PROMPT_CONSTRAINTS,
    });
    let first = prompt.find("# 任务 1：拆分登录表单").expect("任务 1 必在");
    let second = prompt.find("# 任务 2：补齐表单样式").expect("任务 2 必在");
    let third = prompt.find("# 任务 3：增加错误码").expect("任务 3 必在");
    assert!(first < second && second < third, "段序必须是树前序");
    // 回执清单与 tasks 数组同序，避免 Agent 按错号回执。
    let list_a1 = prompt.find("- `a1` 拆分登录表单").expect("回执清单含 a1");
    let list_b2 = prompt.find("- `b2` 增加错误码").expect("回执清单含 b2");
    assert!(list_a1 < list_b2);
    assert!(prompt.contains("运行 ID：`run_m`"));
    assert_eq!(prompt.matches("运行 ID：`run_m`").count(), 1, "多选共用一个 run");
}

#[test]
fn ancestor_selected_drops_descendant() {
    let all = sibling_tree();
    // 同时选中 A 和 A1：A1 已被 A 的「子任务」清单覆盖，不能再单独成段。
    let selected = vec![all["a1"].clone(), all["a"].clone()];
    let ordered = normalize_selection(&selected, &all);
    assert_eq!(ordered.len(), 1);
    assert_eq!(ordered[0].id, "a");

    let prompt = build_prompt(&PromptOptions {
        doc_name: "重构登录模块",
        nodes: &ordered,
        all_nodes: &all,
        children_of: &HashMap::from([("a".to_string(), vec!["a1".to_string(), "a2".to_string()])]),
        run_id: None,
        variant: PromptVariant::Plain,
        constraints: DEFAULT_PROMPT_CONSTRAINTS,
    });
    assert!(!prompt.contains("# 任务 1"), "单任务不编号");
    assert!(prompt.contains("# 任务：前端改造"));
    assert_eq!(prompt.matches("# 任务：").count(), 1, "只渲染一段");
    assert!(prompt.contains("- [ ] 拆分登录表单"), "被丢弃的后代仍在父段子任务里");
}

#[test]
fn duplicate_selection_ids_collapse() {
    let all = sibling_tree();
    let selected = vec![all["a1"].clone(), all["a1"].clone(), all["b2"].clone(), all["b2"].clone()];
    let ordered = normalize_selection(&selected, &all);
    let ids: Vec<&str> = ordered.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, ["a1", "b2"]);
}

#[test]
fn deep_tree_preorder_survives_missing_positions() {
    let mut all = sibling_tree();
    // 同位置（脏数据 / 导入）时按 created_at + id 兜底，结果必须稳定可复现。
    all.get_mut("a2").unwrap().position = 1024.0;
    let selected = vec![all["a2"].clone(), all["a1"].clone()];
    let ordered = normalize_selection(&selected, &all);
    let ids: Vec<&str> = ordered.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, ["a1", "a2"]);
}

// ── 约束段自定义（设置页可改，docs/06 §5.1）──

#[test]
fn custom_constraints_replace_default_lines() {
    let fx = single();
    let custom = "改动前先跑一遍现有测试\n不要升级依赖版本";
    for variant in [PromptVariant::Plain, PromptVariant::Receipt] {
        let prompt = fx.prompt_with(Some("run_x"), variant, custom);
        assert!(prompt.contains("## 约束"), "约束段标题固定");
        assert!(prompt.contains("- 改动前先跑一遍现有测试"));
        assert!(prompt.contains("- 不要升级依赖版本"));
        assert!(!prompt.contains("不要执行 `git commit`"), "默认条目必须被整体替换");
    }
}

#[test]
fn custom_constraints_strip_user_bullets_and_blank_lines() {
    let fx = single();
    let custom = "- 第一条\n\n  * 第二条  \n• 第三条\n";
    let prompt = fx.prompt_with(None, PromptVariant::Plain, custom);
    assert!(prompt.contains("- 第一条\n- 第二条\n- 第三条\n"), "统一成 `- ` 前缀");
    assert!(!prompt.contains("- -"), "不得出现双重列表符号");
    assert!(!prompt.contains("- •"));
}

#[test]
fn blank_constraints_fall_back_to_default() {
    let fx = single();
    for blank in ["", "   ", "\n \n"] {
        let prompt = fx.prompt_with(None, PromptVariant::Plain, blank);
        assert_eq!(
            prompt.matches("## 约束").count(),
            1,
            "约束段只能出现一次（空文本回落默认）"
        );
        assert!(prompt.contains("- 完成后用不超过 5 行总结"), "空文本使用内置默认");
    }
}

#[test]
fn normalize_constraints_trims_edges_and_keeps_indent() {
    use super::normalize_constraints;
    assert_eq!(normalize_constraints("\r\n  a  \r\n    b\r\n\r\n"), "  a\n    b");
    assert_eq!(
        normalize_constraints("  "),
        DEFAULT_PROMPT_CONSTRAINTS,
        "纯空白等价于恢复默认"
    );
}

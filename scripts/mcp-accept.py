"""tree-todo v2 MCP 协议级验收：start / complete / 边界 / 红线。

用法：python scripts/mcp-accept.py <场景>
场景：
  proto      S-08 协议符合性（initialize / tools/list / tools/call）+ 红线（无验收工具）
  auth       S-09 鉴权（无 token / 错 token / 非 loopback Origin）
  lifecycle  S-10/S-11 start → running；complete → 待验收（不勾选，红线）
  edges      S-12 边界（无 start 直接 complete / 重复 complete / 收口后再 complete / failed）
"""
import json
import os
import sqlite3
import sys
import urllib.request

for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)

APP_DATA = os.path.expandvars(r"%APPDATA%\com.jeysin.treetodo")
MCP_JSON = os.path.join(APP_DATA, "mcp.json")
DOCS_DIR = os.path.join(APP_DATA, "docs")


def conf():
    with open(MCP_JSON, encoding="utf-8") as f:
        return json.load(f)


def post(path_url, body, token, origin=None):
    req = urllib.request.Request(
        path_url,
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            **({"Origin": origin} if origin else {}),
        },
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def rpc(base, token, method, params=None, rpc_id=1):
    return post(base, {"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params or {}}, token)


def current_doc_db():
    idx = json.load(open(os.path.join(APP_DATA, "documents.json"), encoding="utf-8"))
    doc_id = idx["lastOpened"]
    return os.path.join(DOCS_DIR, f"{doc_id}.db"), doc_id


def db_state(node_id):
    db, _ = current_doc_db()
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    node = c.execute(
        "select status, exec_state, exec_agent_name, exec_duration_ms from nodes where id=?", (node_id,)
    ).fetchone()
    runs = c.execute(
        "select id, status, duration_ms, finished_at is not null from runs order by started_at desc limit 3"
    ).fetchall()
    c.close()
    return {"node": node, "recent_runs": runs}


def latest_leaf():
    """找一个 pending 叶子节点用于实测。"""
    idx = json.load(open(os.path.join(APP_DATA, "documents.json"), encoding="utf-8"))
    db = os.path.join(DOCS_DIR, f"{idx['lastOpened']}.db")
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = c.execute(
        """select id, content from nodes
           where status='pending' and deleted_at is null
             and id not in (select distinct parent_id from nodes where parent_id is not null)
             and id not in (select id from nodes where parent_id is null)"""
    ).fetchall()
    c.close()
    return rows[0] if rows else None


def main():
    scenario = sys.argv[1] if len(sys.argv) > 1 else "proto"
    cfg = conf()
    base = f"http://127.0.0.1:{cfg['port']}/mcp"
    token = cfg["token"]

    if scenario == "proto":
        ok = True
        # initialize
        st, r = rpc(base, token, "initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "accept-drive", "version": "1.0"},
        })
        name = r.get("result", {}).get("serverInfo", {}).get("name")
        print(f"initialize: {st} server={name}")
        ok &= st == 200 and name == "tree-todo"
        # tools/list
        st, r = rpc(base, token, "tools/list")
        tools = [t["name"] for t in r.get("result", {}).get("tools", [])]
        print(f"tools/list: {st} tools={tools}")
        ok &= st == 200
        forbidden = {"accept", "check", "review", "complete_run", "accept_run", "set_status"}
        bad = [t for t in tools if any(f in t.lower() for f in ("accept", "check", "review", "勾选", "验收"))]
        print("红线检查（无验收/勾选类工具）:", "✅ 无" if not bad else f"❌ {bad}")
        ok &= not bad
        # tools/call 缺参数应返回 -32602（正确的 JSON-RPC 错误）
        st, r = rpc(base, token, "tools/call", {"name": tools[0], "arguments": {}})
        code = r.get("error", {}).get("code")
        print(f"tools/call 缺参: {st} code={code}", "✅" if code == -32602 else "❌")
        ok &= code == -32602
        # 未知工具应返回 -32602/-32601
        st, r = rpc(base, token, "tools/call", {"name": "no_such_tool", "arguments": {}})
        print(f"未知工具: {st} -> {json.dumps(r, ensure_ascii=False)[:100]}")
        print("S-08:", "✅" if ok else "❌")

    elif scenario == "auth":
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        st, _ = post(base, body, "wrong-token")
        print(f"错 token: {st} {'✅' if st == 401 else '❌'}")
        st, _ = post(base, body, "")
        print(f"无 token: {st} {'✅' if st == 401 else '❌'}")
        st, _ = post(base, body, token, origin="http://evil.example.com")
        print(f"非 loopback Origin: {st} {'✅' if st == 403 else '❌'}")
        st, _ = post(base, body, token, origin="http://127.0.0.1:1420")
        print(f"loopback Origin: {st} {'✅' if st == 200 else '❌'}")

    elif scenario in ("lifecycle", "edges"):
        leaf = latest_leaf()
        if not leaf:
            print("没有 pending 叶子可用")
            return
        node_id, node_text = leaf
        print(f"用节点: {node_text[:14]} ({node_id[:8]})")
        rpc(base, token, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "acc", "version": "1"}})

        if scenario == "lifecycle":
            st, r = rpc(base, token, "tools/call", {
                "name": "tree_todo_start",
                "arguments": {"run_id": "run_acc1", "node_ids": [node_id], "agent": "验收脚本"},
            }, rpc_id=2)
            print(f"start: {st} -> {json.dumps(r, ensure_ascii=False)[:200]}")
            print("start 后状态:", db_state(node_id))
            st, r = rpc(base, token, "tools/call", {
                "name": "tree_todo_complete_tasks",
                "arguments": {"run_id": "run_acc1", "tasks": [{"id": node_id, "result": "done", "summary": "脚本完成"}]},
            }, rpc_id=3)
            print(f"complete: {st} -> {json.dumps(r, ensure_ascii=False)[:200]}")
            s = db_state(node_id)
            print("complete 后状态:", s)
            redline = s["node"][0] == "pending"
            print("红线（主状态未被勾选）:", "✅" if redline else "❌")

        elif scenario == "edges":
            # 1) 无 start 直接 complete
            st, r = rpc(base, token, "tools/call", {
                "name": "tree_todo_complete_tasks",
                "arguments": {"run_id": "run_edge1", "tasks": [{"id": node_id, "result": "done"}]},
            }, rpc_id=2)
            print(f"无 start 直接 complete: {st} -> {json.dumps(r, ensure_ascii=False)[:140]}")
            print("  状态:", db_state(node_id))
            # 2) start 后重复 complete（幂等）
            rpc(base, token, "tools/call", {"name": "tree_todo_start", "arguments": {"run_id": "run_edge2", "node_ids": [node_id], "agent": "acc"}}, rpc_id=3)
            for i in (4, 5):
                st, r = rpc(base, token, "tools/call", {
                    "name": "tree_todo_complete_tasks",
                    "arguments": {"run_id": "run_edge2", "tasks": [{"id": node_id, "result": "done"}]},
                }, rpc_id=i)
                print(f"complete #{i-3}: {st} -> {json.dumps(r, ensure_ascii=False)[:140]}")
            print("  两次后:", db_state(node_id))


if __name__ == "__main__":
    main()

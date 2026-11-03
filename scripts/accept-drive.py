"""tree-todo P0 验收驱动：通过 CDP（WebView2 远程调试）驱动真实 UI。

用法：
  python scripts/accept-drive.py eval "<js 表达式>"
  python scripts/accept-drive.py click "<css 选择器>"
  python scripts/accept-drive.py text "<css 选择器>"
  python scripts/accept-drive.py shot <输出路径>
  python scripts/accept-drive.py clipboard

说明：
- click 用 Input.dispatchMouseEvent 走真实输入路径（mousedown→mouseup→click），
  能触发 React 的合成事件，与真人点击一致。
- eval 在页面主世界里执行，可以读 store（window.__TT_DEBUG__ 暴露的调试句柄）。
"""
import json
import sys
import time
import urllib.request

for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    import os

    os.environ.pop(k, None)

import websocket  # type: ignore

CDP_HTTP = "http://127.0.0.1:9334"
PAGE_URL_PREFIX = "http://localhost:1420"


def page_ws() -> str:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    targets = json.load(opener.open(f"{CDP_HTTP}/json/list", timeout=10))
    for t in targets:
        if t.get("type") == "page" and str(t.get("url", "")).startswith(PAGE_URL_PREFIX):
            return t["webSocketDebuggerUrl"]
    raise SystemExit("未找到 tree-todo 页面目标")


class Cdp:
    def __init__(self, ws_url: str):
        self.ws = websocket.create_connection(ws_url, timeout=30, http_proxy_host=None)
        self.mid = 0

    def call(self, method, params=None):
        self.mid += 1
        self.ws.send(json.dumps({"id": self.mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def eval(self, expr: str):
        r = self.call(
            "Runtime.evaluate",
            {"expression": expr, "returnByValue": True, "awaitPromise": True},
        )
        res = r.get("result", {})
        if res.get("subtype") == "error":
            raise RuntimeError(res.get("description", "eval failed"))
        return res.get("value")

    def center_of(self, selector: str):
        return self.eval(
            """(() => {
              const el = document.querySelector(arguments_sel);
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return {x: r.x + r.width / 2, y: r.y + r.height / 2};
            })()""".replace("arguments_sel", json.dumps(selector))
        )

    def click(self, selector: str):
        pos = self.center_of(selector)
        if not pos:
            raise SystemExit(f"找不到元素: {selector}")
        self.click_at(pos["x"], pos["y"])

    def click_at(self, x: float, y: float, button: str = "left"):
        for type_ in ("mousePressed", "mouseReleased"):
            self.call(
                "Input.dispatchMouseEvent",
                {
                    "type": type_,
                    "x": x,
                    "y": y,
                    "button": button,
                    "clickCount": 1,
                },
            )

    def shot(self, path: str):
        data = self.call("Page.captureScreenshot", {"format": "png"})["data"]
        import base64

        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
        print("shot ->", path)


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cmd = sys.argv[1]
    ws = page_ws()
    c = Cdp(ws)
    c.call("Runtime.enable")
    c.call("Page.enable")

    if cmd == "eval":
        print(json.dumps(c.eval(sys.argv[2]), ensure_ascii=False, default=str))
    elif cmd == "click":
        c.click(sys.argv[2])
        time.sleep(0.6)
        print("clicked")
    elif cmd == "clickat":
        x, y = float(sys.argv[2]), float(sys.argv[3])
        c.click_at(x, y)
        time.sleep(0.6)
        print(f"clicked at {x},{y}")
    elif cmd == "rclickat":
        x, y = float(sys.argv[2]), float(sys.argv[3])
        c.click_at(x, y, button="right")
        time.sleep(0.6)
        print(f"right-clicked at {x},{y}")
    elif cmd == "text":
        print(c.eval(f"document.querySelector({json.dumps(sys.argv[2])})?.textContent ?? ''"))
    elif cmd == "shot":
        c.shot(sys.argv[2])
    elif cmd == "clipboard":
        # 用 Windows 剪贴板读取验证（子进程）。
        import subprocess

        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Get-Clipboard"],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        out = r.stdout.strip()
        print(out[:2000] if out else "(剪贴板为空)")
    else:
        raise SystemExit(f"未知命令: {cmd}")


if __name__ == "__main__":
    main()

"""UI 驱动：复制带回执 Prompt → 提取 run_id → 存到 /tmp/variant_b.txt"""
import json
import re
import subprocess
import sys
import time

sys.path.insert(0, 'scripts')
from importlib import import_module  # noqa: E402

ad = import_module('accept-drive')
c = ad.Cdp(ad.page_ws())
c.call("Runtime.enable")

r = json.loads(c.eval("""JSON.stringify((() => {
  const s = window.__TT_TODO__.getState();
  const isLeaf = n => !Object.values(s.nodes).some(x => x.parentId === n.id);
  const leaf = Object.values(s.nodes).find(n => n.status === 'pending' && !s.roots.includes(n.id) && isLeaf(n));
  return leaf ? {id: leaf.id, t: leaf.content.slice(0, 12)} : null;
})())"""))
print('pending 叶子:', r)
NODE = r['id']

pos = c.eval(f"(() => {{ const el = document.querySelector('me-tpc[data-nodeid=\"me{NODE}\"]'); const r2 = el.getBoundingClientRect(); return {{x: r2.x + r2.width/2, y: r2.y + r2.height/2}}; }})()")
c.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": pos['x'], "y": pos['y'], "button": "right", "clickCount": 1})
c.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": pos['x'], "y": pos['y'], "button": "right", "clickCount": 1})
time.sleep(0.6)

res = c.eval("""(() => {
  const btn = [...document.querySelectorAll('[data-context-menu] button')].find(b => (b.textContent ?? '').includes('带回执'));
  if (!btn) return 'no-btn';
  btn.click();
  return 'copied';
})()""")
print('复制带回执:', res)
time.sleep(1.2)

# 用 python 直接读剪贴板（ctypes，注意 64 位指针类型标注）
import ctypes

CF_UNICODETEXT = 13
k32 = ctypes.windll.kernel32
u32 = ctypes.windll.user32
u32.OpenClipboard.argtypes = [ctypes.c_void_p]
u32.GetClipboardData.argtypes = [ctypes.c_uint]
u32.GetClipboardData.restype = ctypes.c_void_p
k32.GlobalLock.argtypes = [ctypes.c_void_p]
k32.GlobalLock.restype = ctypes.c_void_p
k32.GlobalUnlock.argtypes = [ctypes.c_void_p]
clip = ''
if u32.OpenClipboard(None):
    try:
        h = u32.GetClipboardData(CF_UNICODETEXT)
        if h:
            p = k32.GlobalLock(h)
            if p:
                clip = ctypes.wstring_at(p)
                k32.GlobalUnlock(h)
    finally:
        u32.CloseClipboard()

m = re.search(r'run_id[：:]\s*`?([A-Za-z0-9_-]+)`?', clip)
run_id = m.group(1) if m else None
print('剪贴板长度:', len(clip), '| run_id:', run_id)
print('--- 变体 B 内容抽样 ---')
print(clip[:700])
open('/tmp/run_id.txt', 'w').write(run_id or '')
open('/tmp/variant_b.txt', 'w', encoding='utf-8').write(clip)
open('/tmp/variant_b_node.txt', 'w').write(NODE)

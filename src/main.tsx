import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

// 开发期诊断：未捕获错误直接显示在页面上（白屏时一眼看到原因）。
// 生产构建里不启用（import.meta.env.DEV 会被静态剔除）。
if (import.meta.env.DEV) {
  const showFatal = (label: string, detail: string) => {
    const el = document.createElement('pre');
    el.style.cssText =
      'position:fixed;inset:0;z-index:99999;margin:0;padding:16px;background:#1a1d23;color:#ff6b6b;font:12px/1.6 monospace;white-space:pre-wrap;overflow:auto';
    el.textContent = `${label}\n\n${detail}`;
    document.body.appendChild(el);
  };
  window.addEventListener('error', e => {
    showFatal(
      'UNCAUGHT ERROR',
      `${e.message}\n${e.filename}:${e.lineno}:${e.colno}\n\n${e.error?.stack ?? ''}`,
    );
  });
  window.addEventListener('unhandledrejection', e => {
    showFatal('UNHANDLED REJECTION', String((e.reason as Error)?.stack ?? e.reason));
  });
}

// 验收钩子：暴露 store 给验收脚本（仅开发构建；生产里 undefined）。
if (import.meta.env.DEV) {
  void import('./stores/todoStore').then(m => {
    (window as unknown as Record<string, unknown>).__TT_TODO__ = m.useTodoStore;
    void import('./stores/runStore').then(r => {
      (window as unknown as Record<string, unknown>).__TT_RUN__ = r.useRunStore;
    });
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

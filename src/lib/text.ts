/** 纯文本工具：布局宽度估算等。 */

/** 估算内容显示宽度（px）：中文/全角 14px，其余 8px（docs/03 §2.1 节点宽度自适应）。 */
export function estimateTextWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 14 : 8;
  }
  return w;
}

/** 节点卡片宽度：内容宽度 + checkbox/折叠钮等固定留白，clamp 到 [96, 260]。 */
export function nodeCardWidth(content: string): number {
  return Math.min(260, Math.max(96, estimateTextWidth(content) + 56));
}

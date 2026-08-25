// ============================================================
// 微信正文 HTML 轻量清洗（参考 Python html_cleaner.py）
// 目标：删 script/style、按块级标签分段、去噪音行、拼接纯文本。
// 严禁把原 HTML 直接入库或返回给前端。
// ============================================================

const NOISE_LINE_PATTERNS: RegExp[] = [
  /^阅读原文$/,
  /^点击.*关注/,
  /^微信扫一扫/,
  /^长按识别/,
  /^预览时标签不可点/,
  /^收录于话题/,
  /^免责声明/,
  /^版权归原作者所有/,
  /^参考资料?：?$/,
];

function isNoise(line: string): boolean {
  if (line.length < 4) return true;
  return NOISE_LINE_PATTERNS.some((p) => p.test(line));
}

/** 清洗正文 HTML → 纯文本（段落以空行分隔） */
export function cleanWechatHtml(html: string): { text: string; outline: string } {
  let cleaned = html || '';
  // 去 script/style/注释
  cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, ' ');
  // 块级结束标签 → 换行，保留段落边界
  cleaned = cleaned.replace(/<br\s*\/?>/gi, '\n');
  cleaned = cleaned.replace(/<\/p\s*>/gi, '\n\n');
  cleaned = cleaned.replace(/<\/(?:section|div|h[1-6]|li|blockquote|ul|ol)\s*>/gi, '\n');
  // 剩余任意标签 → 空格
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  // 实体解码 + nbsp
  cleaned = cleaned.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  cleaned = cleaned.replace(/\u00a0/g, ' ');

  // 按换行拆成行，清洗空格，过滤噪音（每行独立判定）
  const lines = cleaned
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);

  const blocks: string[] = [];
  for (const line of lines) {
    if (isNoise(line)) continue;
    // 长行按中文句读拆分
    if (line.length > 200 && (line.match(/[。！？!?]/g) || []).length >= 2) {
      const parts = line.split(/(?<=[。！？!?])\s*/);
      for (const p of parts) {
        const t = p.trim();
        if (t.length >= 8 && !isNoise(t)) blocks.push(t);
      }
      continue;
    }
    blocks.push(line);
  }

  // 若几乎没有段落（HTML 解析失败），退化：按句号切原始文本
  if (blocks.length < 2 && cleaned.trim()) {
    const chunk = cleaned.replace(/\s+/g, ' ').trim();
    const parts = chunk.split(/(?<=[。！？!?])\s*/).filter((p) => p.trim().length >= 10);
    return {
      text: parts.slice(0, 30).join('\n\n'),
      outline: JSON.stringify(parts.slice(0, 30).map((p) => ({ type: 'paragraph', text: p.trim() }))),
    };
  }

  const text = blocks.join('\n\n');
  const outline = blocks.map((b) => ({ type: 'paragraph', text: b }));
  return { text, outline: JSON.stringify(outline) };
}

/** 统计中文字符数 */
export function countCjkChars(text: string): number {
  const m = text.match(/[\u3400-\u9FFF]/g);
  return m ? m.length : 0;
}

/** 是否存在危险 HTML（阻止将其入库） */
export function hasDangerousHtml(html: string): boolean {
  return /<(script|iframe|object|embed|form|input)[\s>]/i.test(html);
}

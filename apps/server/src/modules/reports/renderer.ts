/**
 * Markdown → 单文件 HTML 渲染器（契约 §9：内联 CSS、可浏览器打印 PDF）。
 *
 * 为什么自己写而不引入 marked：
 * 1. 服务端多一个纯渲染依赖不值得（报告 Markdown 由我们生成，语法子集固定）；
 * 2. 安全：所有文本先 HTML 转义，链接只允许 http(s)/相对路径，彻底杜绝情报标题里的 XSS；
 * 3. 单文件输出：不依赖外部图片/字体，方便直接归档与打印。
 */
/** 渲染入参。 */
export interface RenderReportOptions {
  title: string;
  markdown: string;
  generatedAt: string;
  /** 页脚展示的产品名（默认 Knetsec_Ai）。 */
  appName?: string;
}

/** HTML 特殊字符转义（文本与属性值统一走这里）。 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 只允许安全协议/相对路径，防止 javascript: / data: 链接注入。 */
function isSafeUrl(url: string): boolean {
  return /^(https?:\/\/|\/|#)/i.test(url);
}

/** 行内 Markdown → HTML（先转义，再替换受控语法）。 */
function renderInline(raw: string): string {
  let out = escapeHtml(raw);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    if (!isSafeUrl(url)) return label;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return out;
}

/** 拆分表格行：先把转义的竖线换成占位符，避免误切列，拆分后再还原。 */
const ESCAPED_PIPE = '\u0001';

function splitTableRow(line: string): string[] {
  const normalized = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const prepared = normalized.replace(/\\\|/g, ESCAPED_PIPE);
  return prepared.split('|').map((cell) => cell.split(ESCAPED_PIPE).join('|').trim());
}

/** 判断是否为表格分隔行（| --- | --- |）。 */
function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/** 列表项解析结果。 */
interface ListItem {
  ordered: boolean;
  text: string;
}

/** Markdown → HTML 正文（支持标题/列表/表格/引用/分隔线/段落）。 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let index = 0;
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let quoteLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!listType) return;
    html.push(listType === 'ul' ? '</ul>' : '</ol>');
    listType = null;
  };
  const flushQuote = (): void => {
    if (quoteLines.length === 0) return;
    html.push(`<blockquote><p>${quoteLines.map(renderInline).join('<br>')}</p></blockquote>`);
    quoteLines = [];
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    // 空行：结束当前块
    if (trimmed === '') {
      flushAll();
      index += 1;
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushAll();
      const level = heading[1]?.length ?? 1;
      html.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
      index += 1;
      continue;
    }

    // 分隔线
    if (/^-{3,}$/.test(trimmed)) {
      flushAll();
      html.push('<hr>');
      index += 1;
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (trimmed.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? '')) {
      flushAll();
      const headerCells = splitTableRow(line);
      index += 2;
      const bodyRows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').trim().includes('|')) {
        bodyRows.push(splitTableRow(lines[index] ?? ''));
        index += 1;
      }
      html.push('<table>');
      html.push('<thead><tr>');
      for (const cell of headerCells) html.push(`<th>${renderInline(cell)}</th>`);
      html.push('</tr></thead>');
      html.push('<tbody>');
      for (const row of bodyRows) {
        html.push('<tr>');
        for (const cell of row) html.push(`<td>${renderInline(cell)}</td>`);
        html.push('</tr>');
      }
      html.push('</tbody></table>');
      continue;
    }

    // 引用
    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      flushList();
      quoteLines.push(trimmed.replace(/^>\s?/, ''));
      index += 1;
      continue;
    }

    // 列表
    const listMatch = /^([-*]|\d+\.)\s+(.*)$/.exec(trimmed);
    if (listMatch) {
      flushParagraph();
      flushQuote();
      const ordered = /^\d+\.$/.test(listMatch[1] ?? '');
      const nextType: 'ul' | 'ol' = ordered ? 'ol' : 'ul';
      if (listType && listType !== nextType) flushList();
      if (!listType) {
        listType = nextType;
        html.push(nextType === 'ul' ? '<ul>' : '<ol>');
      }
      html.push(`<li>${renderInline(listMatch[2] ?? '')}</li>`);
      index += 1;
      continue;
    }

    // 普通段落
    flushList();
    flushQuote();
    paragraph.push(trimmed);
    index += 1;
  }
  flushAll();

  return html.join('\n');
}

/** 内联样式：单文件、可直接打印 PDF（无外部依赖）。 */
const REPORT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 64px;
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
    font-size: 15px; line-height: 1.75; color: #1f2937; background: #f8fafc;
  }
  .report {
    max-width: 920px; margin: 0 auto; background: #ffffff; padding: 48px 56px;
    border-radius: 12px; box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08);
  }
  h1 { font-size: 26px; line-height: 1.4; margin: 0 0 12px; color: #0b1220; border-bottom: 3px solid #2563eb; padding-bottom: 14px; }
  h2 { font-size: 20px; margin: 36px 0 14px; color: #0b1220; border-left: 4px solid #2563eb; padding-left: 12px; }
  h3 { font-size: 16px; margin: 24px 0 8px; color: #1e3a8a; }
  p { margin: 10px 0; }
  ul, ol { margin: 10px 0 10px 24px; padding: 0; }
  li { margin: 6px 0; }
  blockquote {
    margin: 12px 0; padding: 10px 16px; background: #eff6ff;
    border-left: 4px solid #93c5fd; color: #1e40af; border-radius: 4px;
  }
  blockquote p { margin: 0; }
  code { background: #f1f5f9; padding: 1px 6px; border-radius: 4px; font-family: Consolas, monospace; font-size: 13px; }
  a { color: #2563eb; text-decoration: none; word-break: break-all; }
  a:hover { text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; color: #0f172a; font-weight: 600; }
  tr:nth-child(even) td { background: #f8fafc; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 32px 0; }
  footer { max-width: 920px; margin: 20px auto 0; text-align: center; color: #94a3b8; font-size: 12px; }
  @media print {
    body { background: #ffffff; padding: 0; }
    .report { box-shadow: none; border-radius: 0; padding: 0; max-width: none; }
    h2 { page-break-after: avoid; }
    table, blockquote { page-break-inside: avoid; }
  }
`;

/**
 * 渲染完整 HTML 文档（单文件，内联 CSS）。
 * 注意：title / markdown 中的用户数据都经过 escapeHtml，不存在未转义插值。
 */
export function renderReportHtml(options: RenderReportOptions): string {
  const body = markdownToHtml(options.markdown);
  const safeTitle = escapeHtml(options.title);
  const safeApp = escapeHtml(options.appName ?? 'Knetsec_Ai');
  const safeGeneratedAt = escapeHtml(options.generatedAt);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<article class="report">
${body}
</article>
<footer>${safeApp} · 生成于 ${safeGeneratedAt} · 仅供内部运营参考</footer>
</body>
</html>
`;
}

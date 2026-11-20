/**
 * 报告 HTML 渲染单测：Markdown 子集、HTML 转义（XSS 防护）、外链白名单、单文件输出。
 */
import { describe, expect, it } from 'vitest';
import { escapeHtml, markdownToHtml, renderReportHtml } from '../src/modules/reports/renderer.js';

describe('报告渲染：HTML 转义', () => {
  it('转义 & < > " 单引号', () => {
    expect(escapeHtml('<script>alert("x")</script> & \'')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;',
    );
  });

  it('标题中的脚本不进入 HTML 原样', () => {
    const html = renderReportHtml({
      title: '<script>alert(1)</script>',
      markdown: '# 正常标题',
      generatedAt: '2026-11-17T08:00:00.000Z',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('正文中的脚本与事件属性被转义', () => {
    const html = markdownToHtml('## <img src=x onerror=alert(1)> 标题\n\n<img src=x onerror=alert(2)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('javascript: 链接不生成 href', () => {
    const html = markdownToHtml('[点我](javascript:alert(1))');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('点我');
  });

  it('http(s) 链接正常生成并带 noopener', () => {
    const html = markdownToHtml('[官网](https://example.com/a?b=1&c=2)');
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('报告渲染：Markdown 子集', () => {
  it('支持标题/列表/表格/引用/分隔线/加粗/行内代码', () => {
    const markdown = [
      '# 一级标题',
      '## 二级标题',
      '',
      '- 列表项 **加粗**',
      '- 列表项 `code`',
      '',
      '| 编号 | 组件 |',
      '|---|---|',
      '| CVE-2025-1 | vLLM |',
      '',
      '> 引用内容',
      '',
      '---',
    ].join('\n');
    const html = markdownToHtml(markdown);
    expect(html).toContain('<h1>一级标题</h1>');
    expect(html).toContain('<h2>二级标题</h2>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>编号</th>');
    expect(html).toContain('<td>CVE-2025-1</td>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<hr>');
  });

  it('表格单元格里的竖线转义不会被拆列', () => {
    const html = markdownToHtml('| 标题 | 状态 |\n|---|---|\n| A \\| B | 在野利用 |');
    expect(html).toContain('<td>A | B</td>');
  });

  it('renderReportHtml 输出单文件（内联 CSS，无外部资源）', () => {
    const html = renderReportHtml({
      title: '测试报告',
      markdown: '# 标题\n\n正文',
      generatedAt: '2026-11-17 16:00',
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('</style>');
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('<script');
    expect(html).toContain('<article class="report">');
  });
});

<script setup lang="ts">
/**
 * Markdown 渲染组件（报告预览、详情页共用）。
 *
 * 安全：报告内容来自数据库，但仍按不可信输入处理——marked 渲染后必须经
 * DOMPurify 消毒再 v-html，防止历史数据被注入 script/onerror 造成存储型 XSS。
 */
import { computed } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface Props {
  markdown: string;
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), { loading: false });

const html = computed(() => {
  const source = props.markdown ?? '';
  if (!source.trim()) return '';
  // async: false 保证 render 是同步字符串，computed 才能直接使用。
  const rendered = marked.parse(source, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(String(rendered), { USE_PROFILES: { html: true } });
});
</script>

<template>
  <div v-loading="props.loading" class="markdown-viewer">
    <el-empty v-if="!html" description="暂无报告内容" :image-size="96" />
    <!-- eslint-disable-next-line vue/no-v-html -- html 已由 DOMPurify.sanitize 消毒，见上方 computed -->
    <article v-else class="markdown-body" v-html="html" />
  </div>
</template>

<style scoped>
.markdown-viewer {
  min-height: 200px;
}

.markdown-body {
  font-size: 14px;
  line-height: 1.8;
  color: #1f2937;
  word-break: break-word;
}

.markdown-body :deep(h1) {
  margin: 8px 0 20px;
  font-size: 24px;
  font-weight: 600;
  line-height: 1.4;
}

.markdown-body :deep(h2) {
  margin: 28px 0 12px;
  padding-bottom: 8px;
  font-size: 19px;
  font-weight: 600;
  border-bottom: 1px solid #eef1f6;
}

.markdown-body :deep(h3) {
  margin: 20px 0 10px;
  font-size: 16px;
  font-weight: 600;
}

.markdown-body :deep(p) {
  margin: 0 0 12px;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0 0 12px;
  padding-left: 24px;
}

.markdown-body :deep(li) {
  margin: 4px 0;
}

.markdown-body :deep(a) {
  color: var(--knet-primary);
  text-decoration: none;
}

.markdown-body :deep(a:hover) {
  text-decoration: underline;
}

.markdown-body :deep(code) {
  padding: 2px 5px;
  font-family: 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
  font-size: 13px;
  color: #b91c1c;
  background: #f1f5f9;
  border-radius: 4px;
}

.markdown-body :deep(pre) {
  margin: 0 0 14px;
  padding: 12px 14px;
  overflow-x: auto;
  background: #0f172a;
  border-radius: 8px;
}

.markdown-body :deep(pre code) {
  padding: 0;
  color: #e2e8f0;
  background: transparent;
}

.markdown-body :deep(blockquote) {
  margin: 0 0 14px;
  padding: 8px 14px;
  color: #475569;
  background: #f8fafc;
  border-left: 3px solid var(--knet-primary);
  border-radius: 0 6px 6px 0;
}

.markdown-body :deep(table) {
  width: 100%;
  margin: 0 0 16px;
  border-collapse: collapse;
  font-size: 13px;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  padding: 8px 10px;
  border: 1px solid #e5e7eb;
  text-align: left;
}

.markdown-body :deep(th) {
  background: #f8fafc;
  font-weight: 600;
}

.markdown-body :deep(hr) {
  margin: 20px 0;
  border: none;
  border-top: 1px solid #e5e7eb;
}

.markdown-body :deep(img) {
  max-width: 100%;
}
</style>

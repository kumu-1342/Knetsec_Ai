<script setup lang="ts">
/**
 * 页面标题区。
 *
 * 统一标题字号、描述颜色与右侧操作区的位置，避免每个页面各写一套间距，
 * 也方便后续加「帮助文档链接」等全局元素。
 */
interface Props {
  title: string;
  description?: string;
}

const props = withDefaults(defineProps<Props>(), { description: '' });
</script>

<template>
  <div class="page-header">
    <div class="page-header-text">
      <h1 class="page-header-title">{{ props.title }}</h1>
      <p v-if="props.description" class="page-header-desc">{{ props.description }}</p>
    </div>
    <div class="page-header-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.page-header-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--knet-text);
}

.page-header-desc {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--knet-text-secondary);
}

.page-header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}
</style>

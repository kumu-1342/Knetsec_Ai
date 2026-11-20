<script setup lang="ts">
/**
 * 指标卡：仪表盘顶部 4 个核心数字。
 *
 * 为什么把数字格式化放在组件内：所有指标卡都必须千分位展示，调用方只传原始数字即可。
 */
import { computed, type Component } from 'vue';
import { formatNumber } from '@/utils/format';

interface Props {
  /** 指标名称，例如「总情报」 */
  label: string;
  /** 指标值；数字会做千分位格式化 */
  value: number | string;
  /** 补充说明，如「较昨日 +12」 */
  hint?: string;
  /** 左侧图标组件（@element-plus/icons-vue） */
  icon?: Component;
  /** 图标与左侧色条的主色 */
  color?: string;
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  hint: '',
  color: '#2563eb',
  loading: false,
  icon: undefined,
});

const displayValue = computed(() =>
  typeof props.value === 'number' ? formatNumber(props.value) : props.value,
);
const iconStyle = computed(() => ({ backgroundColor: `${props.color}14`, color: props.color }));
</script>

<template>
  <div v-loading="props.loading" class="stat-card knet-card">
    <div class="stat-icon" :style="iconStyle">
      <el-icon v-if="props.icon" :size="22">
        <component :is="props.icon" />
      </el-icon>
    </div>
    <div class="stat-main">
      <div class="stat-label">{{ props.label }}</div>
      <div class="stat-value">{{ displayValue }}</div>
      <div v-if="props.hint" class="stat-hint">{{ props.hint }}</div>
    </div>
  </div>
</template>

<style scoped>
.stat-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px;
  min-height: 96px;
  min-width: 0;
}

.stat-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 12px;
  flex-shrink: 0;
}

.stat-main {
  min-width: 0;
}

.stat-label {
  font-size: 13px;
  color: var(--knet-text-secondary);
}

.stat-value {
  margin-top: 4px;
  font-size: 26px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--knet-text);
  font-variant-numeric: tabular-nums;
}

.stat-hint {
  margin-top: 2px;
  font-size: 12px;
  color: var(--knet-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

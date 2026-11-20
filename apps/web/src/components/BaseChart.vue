<script setup lang="ts">
/**
 * ECharts 轻封装。
 *
 * 封装目的：每个图表都要处理实例创建、容器尺寸变化、option 更新与销毁，
 * 页面只关心 option，不需要重复写生命周期代码（也避免内存泄漏）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';

interface Props {
  option: EChartsOption;
  height?: string;
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), { height: '300px', loading: false });
const container = ref<HTMLDivElement | null>(null);
let chart: ReturnType<typeof echarts.init> | null = null;

/** 窗口尺寸变化时重算画布，保证侧边栏折叠后图表不留白边。 */
function handleResize(): void {
  chart?.resize();
}

onMounted(() => {
  if (!container.value) return;
  chart = echarts.init(container.value);
  chart.setOption(props.option, true);
  window.addEventListener('resize', handleResize);
});

watch(
  () => props.option,
  (option) => {
    chart?.setOption(option, true);
  },
  { deep: true },
);

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div ref="container" v-loading="props.loading" class="base-chart" :style="{ height: props.height }" />
</template>

<style scoped>
.base-chart {
  width: 100%;
}
</style>

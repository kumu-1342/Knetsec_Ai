<script setup lang="ts">
/**
 * 仪表盘。
 *
 * 数据来源只有 GET /dashboard/summary 一个接口，避免页面并发多个统计请求导致数字不一致。
 * 图表只做「读」：趋势看节奏、环形看严重度结构、柱状看分类分布、来源 Top10 看渠道健康度。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import dayjs from 'dayjs';
import type { EChartsOption } from 'echarts';
import { Bell, Calendar, Document, Refresh, Warning } from '@element-plus/icons-vue';
import { ITEM_CATEGORY_LABELS, SEVERITY_LABELS, type DashboardSummary, type Severity } from '@knetsec/shared';
import { dashboardApi } from '@/api';
import { formatDateTime, formatDuration, formatNumber, formatRelative } from '@/utils/format';
import { RUN_STATUS_META, RUN_TRIGGER_LABELS } from '@/utils/enums';
import PageHeader from '@/components/PageHeader.vue';
import StatCard from '@/components/StatCard.vue';
import BaseChart from '@/components/BaseChart.vue';
import SeverityTag from '@/components/SeverityTag.vue';

const router = useRouter();
const summary = ref<DashboardSummary | null>(null);
const loading = ref(false);
const errorMessage = ref('');

/** 严重度图表配色：与 SeverityTag 的语义色保持一致。 */
const SEVERITY_CHART_COLORS: Record<Severity, string> = {
  critical: '#dc2626',
  high: '#f97316',
  medium: '#2563eb',
  low: '#16a34a',
  info: '#64748b',
  unknown: '#94a3b8',
};

async function loadSummary(): Promise<void> {
  loading.value = true;
  errorMessage.value = '';
  try {
    summary.value = await dashboardApi.summary();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '仪表盘数据加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadSummary();
});

const totals = computed(() => summary.value?.totals ?? null);

/** 4 个指标卡：契约要求的「总情报 / 今日新增 / 未读 / 严重 7 天」。 */
const statCards = computed(() => [
  {
    label: '总情报',
    value: totals.value?.items ?? 0,
    hint: `覆盖 ${formatNumber(totals.value?.sources ?? 0)} 个数据源`,
    icon: Document,
    color: '#2563eb',
  },
  {
    label: '今日新增',
    value: totals.value?.itemsToday ?? 0,
    hint: `近 7 天 ${formatNumber(totals.value?.items7d ?? 0)} 条`,
    icon: Calendar,
    color: '#16a34a',
  },
  {
    label: '未读情报',
    value: totals.value?.unread ?? 0,
    hint: '待运营处理',
    icon: Bell,
    color: '#f59e0b',
  },
  {
    label: '严重 7 天',
    value: totals.value?.critical7d ?? 0,
    hint: 'critical 级别新增',
    icon: Warning,
    color: '#dc2626',
  },
]);

const trendOption = computed<EChartsOption>(() => {
  const trend = summary.value?.trend ?? [];
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
    grid: { left: 42, right: 18, top: 40, bottom: 26 },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: trend.map((point) => dayjs(point.date).format('MM-DD')),
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      axisLabel: { color: '#64748b' },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      splitLine: { lineStyle: { color: '#f1f5f9' } },
      axisLabel: { color: '#64748b' },
    },
    series: [
      {
        name: '全部情报',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: trend.map((point) => point.total),
        lineStyle: { width: 2, color: '#2563eb' },
        itemStyle: { color: '#2563eb' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(37, 99, 235, 0.22)' },
              { offset: 1, color: 'rgba(37, 99, 235, 0.01)' },
            ],
          },
        },
      },
      {
        name: 'AI 安全',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: trend.map((point) => point.aiSecurity),
        lineStyle: { width: 2, color: '#7c3aed' },
        itemStyle: { color: '#7c3aed' },
      },
      {
        name: '漏洞',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: trend.map((point) => point.vuln),
        lineStyle: { width: 2, color: '#f97316' },
        itemStyle: { color: '#f97316' },
      },
    ],
  };
});

const severityOption = computed<EChartsOption>(() => {
  const distribution = summary.value?.severityDistribution ?? [];
  return {
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, icon: 'circle', itemWidth: 9, itemHeight: 9, textStyle: { fontSize: 12 } },
    series: [
      {
        name: '严重度分布',
        type: 'pie',
        radius: ['46%', '68%'],
        center: ['50%', '42%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
        label: { show: false },
        emphasis: { label: { show: true, fontSize: 13, fontWeight: 'bold', formatter: '{b}\n{c} 条' } },
        data: distribution.map((entry) => ({
          name: SEVERITY_LABELS[entry.severity],
          value: entry.count,
          itemStyle: { color: SEVERITY_CHART_COLORS[entry.severity] },
        })),
      },
    ],
  };
});

const categoryOption = computed<EChartsOption>(() => {
  const distribution = summary.value?.categoryDistribution ?? [];
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 96, right: 28, top: 10, bottom: 22 },
    xAxis: {
      type: 'value',
      minInterval: 1,
      splitLine: { lineStyle: { color: '#f1f5f9' } },
      axisLabel: { color: '#64748b' },
    },
    yAxis: {
      type: 'category',
      data: distribution.map((entry) => ITEM_CATEGORY_LABELS[entry.category]),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#475569', fontSize: 12 },
    },
    series: [
      {
        name: '条目数',
        type: 'bar',
        barMaxWidth: 16,
        data: distribution.map((entry) => entry.count),
        itemStyle: { color: '#2563eb', borderRadius: [0, 4, 4, 0] },
      },
    ],
  };
});

/** 来源 Top10：用进度条而非图表，数字更直观，也方便在窄栏里阅读。 */
const topSources = computed(() => {
  const list = [...(summary.value?.sourceDistribution ?? [])].sort((a, b) => b.count - a.count).slice(0, 10);
  const max = list.length > 0 ? Math.max(...list.map((entry) => entry.count), 1) : 1;
  return list.map((entry) => ({ ...entry, percent: Math.round((entry.count / max) * 100) }));
});

const latestItems = computed(() => summary.value?.latestItems ?? []);
const recentRuns = computed(() => summary.value?.recentRuns ?? []);

function goItems(): void {
  void router.push('/items');
}
</script>

<template>
  <div class="page-container">
    <PageHeader title="仪表盘" description="Knetsec_Ai 情报采集与运营总览">
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadSummary">刷新</el-button>
        <el-button @click="router.push('/tasks')">立即采集</el-button>
        <el-button type="primary" @click="router.push('/reports')">生成报告</el-button>
      </template>
    </PageHeader>

    <el-result v-if="errorMessage && !summary" icon="error" title="仪表盘加载失败" :sub-title="errorMessage">
      <template #extra>
        <el-button type="primary" @click="loadSummary">重试</el-button>
      </template>
    </el-result>

    <template v-else>
      <el-row :gutter="16" class="stat-row">
        <el-col v-for="card in statCards" :key="card.label" :xs="24" :sm="12" :lg="6">
          <StatCard
            :label="card.label"
            :value="card.value"
            :hint="card.hint"
            :icon="card.icon"
            :color="card.color"
            :loading="loading"
          />
        </el-col>
      </el-row>

      <el-row :gutter="16" class="chart-row">
        <el-col :xs="24" :lg="16">
          <div class="knet-card chart-card">
            <div class="knet-card-header">
              <span class="knet-card-title">14 天情报趋势</span>
              <span class="knet-muted">按发布时间统计</span>
            </div>
            <div class="knet-card-body">
              <BaseChart :option="trendOption" height="300px" :loading="loading" />
            </div>
          </div>
        </el-col>
        <el-col :xs="24" :lg="8">
          <div class="knet-card chart-card">
            <div class="knet-card-header">
              <span class="knet-card-title">严重度分布</span>
            </div>
            <div class="knet-card-body">
              <BaseChart :option="severityOption" height="300px" :loading="loading" />
            </div>
          </div>
        </el-col>
      </el-row>

      <el-row :gutter="16" class="chart-row">
        <el-col :xs="24" :lg="12">
          <div class="knet-card chart-card">
            <div class="knet-card-header">
              <span class="knet-card-title">分类分布</span>
            </div>
            <div class="knet-card-body">
              <BaseChart :option="categoryOption" height="280px" :loading="loading" />
            </div>
          </div>
        </el-col>

        <el-col :xs="24" :lg="12">
          <div class="knet-card chart-card">
            <div class="knet-card-header">
              <span class="knet-card-title">来源 Top10</span>
              <el-button text type="primary" size="small" @click="goItems">查看全部</el-button>
            </div>
            <div class="knet-card-body source-list">
              <el-empty
                v-if="!loading && topSources.length === 0"
                description="暂无来源统计数据"
                :image-size="72"
              />
              <div v-for="(source, index) in topSources" :key="source.sourceKey" class="source-item">
                <div class="source-item-head">
                  <span class="source-rank" :class="{ 'is-top': index < 3 }">{{ index + 1 }}</span>
                  <span class="source-name" :title="source.sourceName">{{ source.sourceName }}</span>
                  <span class="source-count">{{ formatNumber(source.count) }}</span>
                </div>
                <el-progress
                  :percentage="source.percent"
                  :show-text="false"
                  :stroke-width="6"
                  color="#2563eb"
                />
              </div>
            </div>
          </div>
        </el-col>
      </el-row>

      <el-row :gutter="16" class="chart-row">
        <el-col :xs="24" :lg="15">
          <div class="knet-card chart-card">
            <div class="knet-card-header">
              <span class="knet-card-title">最新情报</span>
              <el-button text type="primary" size="small" @click="goItems">进入情报中心</el-button>
            </div>
            <div class="knet-card-body latest-list">
              <el-empty
                v-if="!loading && latestItems.length === 0"
                description="暂无情报，先触发一次采集"
                :image-size="72"
              />
              <div
                v-for="item in latestItems"
                :key="item.id"
                class="latest-item"
                role="button"
                tabindex="0"
                @click="goItems"
                @keyup.enter="goItems"
              >
                <div class="latest-item-main">
                  <div class="latest-item-title" :title="item.title">{{ item.title }}</div>
                  <div class="latest-item-meta">
                    <span>{{ item.sourceName }}</span>
                    <span class="meta-divider">·</span>
                    <span>{{ formatRelative(item.publishedAt) }}</span>
                    <span v-if="item.isKev" class="kev-flag">KEV</span>
                  </div>
                </div>
                <SeverityTag :severity="item.severity" />
              </div>
            </div>
          </div>
        </el-col>

        <el-col :xs="24" :lg="9">
          <div class="knet-card chart-card">
            <div class="knet-card-header">
              <span class="knet-card-title">最近采集任务</span>
              <el-button text type="primary" size="small" @click="router.push('/tasks')">任务中心</el-button>
            </div>
            <div class="knet-card-body run-list">
              <el-empty
                v-if="!loading && recentRuns.length === 0"
                description="暂无运行记录"
                :image-size="72"
              />
              <div v-for="run in recentRuns" :key="run.id" class="run-item">
                <div class="run-item-head">
                  <span class="run-id">#{{ run.id }}</span>
                  <el-tag :type="RUN_STATUS_META[run.status].type" size="small" effect="light">
                    {{ RUN_STATUS_META[run.status].label }}
                  </el-tag>
                  <span class="run-trigger">{{ RUN_TRIGGER_LABELS[run.trigger] }}</span>
                  <span class="run-time">{{ formatDateTime(run.startedAt) }}</span>
                </div>
                <div class="run-item-meta">
                  <span>新增 {{ formatNumber(run.itemsNew) }} 条</span>
                  <span class="meta-divider">·</span>
                  <span>去重 {{ formatNumber(run.itemsDuplicate) }} 条</span>
                  <span class="meta-divider">·</span>
                  <span>耗时 {{ formatDuration(run.startedAt, run.finishedAt) }}</span>
                </div>
              </div>
            </div>
          </div>
        </el-col>
      </el-row>
    </template>
  </div>
</template>

<style scoped>
.stat-row > .el-col,
.chart-row > .el-col {
  margin-bottom: 16px;
}

.chart-card {
  height: 100%;
}

.latest-list,
.run-list,
.source-list {
  max-height: 320px;
  overflow-y: auto;
}

.latest-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 6px;
  border-bottom: 1px solid #f1f5f9;
  cursor: pointer;
  border-radius: 6px;
}

.latest-item:last-child {
  border-bottom: none;
}

.latest-item:hover {
  background: #f8fafc;
}

.latest-item-main {
  flex: 1;
  min-width: 0;
}

.latest-item-title {
  overflow: hidden;
  font-size: 13px;
  color: var(--knet-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.latest-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  font-size: 12px;
  color: var(--knet-text-muted);
}

.kev-flag {
  padding: 0 5px;
  font-size: 11px;
  color: #b91c1c;
  background: #fee2e2;
  border-radius: 4px;
}

.meta-divider {
  color: #cbd5e1;
}

.source-item {
  margin-bottom: 12px;
}

.source-item:last-child {
  margin-bottom: 0;
}

.source-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
  font-size: 13px;
}

.source-rank {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  font-size: 11px;
  color: #64748b;
  background: #f1f5f9;
  border-radius: 5px;
  flex-shrink: 0;
}

.source-rank.is-top {
  color: #fff;
  background: #2563eb;
}

.source-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--knet-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-count {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--knet-text-secondary);
}

.run-item {
  padding: 10px 6px;
  border-bottom: 1px solid #f1f5f9;
}

.run-item:last-child {
  border-bottom: none;
}

.run-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.run-id {
  font-weight: 600;
  color: var(--knet-text);
}

.run-trigger {
  color: var(--knet-text-secondary);
}

.run-time {
  margin-left: auto;
  font-size: 12px;
  color: var(--knet-text-muted);
}

.run-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
  font-size: 12px;
  color: var(--knet-text-secondary);
}
</style>

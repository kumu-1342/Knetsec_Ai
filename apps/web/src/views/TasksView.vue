<script setup lang="ts">
/**
 * 采集任务。
 *
 * 功能：查看调度器状态、手动触发采集、浏览历史运行、查看运行日志。
 * 轮询策略：手动触发后每 3 秒查询一次运行详情，结束后立即停止并刷新列表与状态；
 * 组件卸载时清理定时器，避免离开页面后仍在后台请求。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, VideoPlay } from '@element-plus/icons-vue';
import { DEFAULT_PAGE_SIZE, type Paginated, type RunDTO, type SourceDTO } from '@knetsec/shared';
import { sourcesApi, tasksApi, type SchedulerStatus } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { formatDateTime, formatDuration, formatNumber } from '@/utils/format';
import { RUN_STATUS_META, RUN_TRIGGER_LABELS } from '@/utils/enums';
import PageHeader from '@/components/PageHeader.vue';

interface DueSourceView {
  key: string;
  name: string;
  /** 调度器计算出的应采集时间 */
  dueAt: string | null;
  intervalMinutes: number;
}

const auth = useAuthStore();

const status = ref<SchedulerStatus | null>(null);
const statusLoading = ref(false);
const runs = ref<Paginated<RunDTO>>({
  items: [],
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
  totalPages: 0,
});
const runsLoading = ref(false);
const runsPage = ref(1);
const runsPageSize = ref(DEFAULT_PAGE_SIZE);
const sources = ref<SourceDTO[]>([]);
const fetchVisible = ref(false);
const selectedSourceKeys = ref<string[]>([]);
const fetching = ref(false);
const activeRun = ref<RunDTO | null>(null);
const detailVisible = ref(false);
const detailRun = ref<RunDTO | null>(null);
const detailLoading = ref(false);
const logContainer = ref<HTMLElement | null>(null);

const enabledSources = computed(() => sources.value.filter((source) => source.enabled));
/** 是否有采集任务正在执行（后端 SchedulerStatus.runningRunId 非空）。 */
const schedulerRunning = computed(
  () => status.value?.runningRunId !== null && status.value?.runningRunId !== undefined,
);
const schedulerEnabled = computed(() => status.value?.enabled === true);
const nextScheduledAt = computed(() => status.value?.jobs[0]?.nextRunAt ?? null);
// 数据源总数以 /sources 为准：/tasks/status 只返回到期候选，不含全量统计。
const enabledSourceCount = computed(() => enabledSources.value.length);
const totalSourceCount = computed(() => sources.value.length);

/** 到期数据源：调度器已按 last_run_at + interval 算好应采集时间。 */
const dueSources = computed<DueSourceView[]>(() =>
  (status.value?.dueSources ?? []).map((item) => ({
    key: item.key,
    name: item.name,
    dueAt: item.dueAt ?? null,
    intervalMinutes: item.intervalMinutes,
  })),
);

async function loadStatus(): Promise<void> {
  statusLoading.value = true;
  try {
    status.value = await tasksApi.status();
  } catch {
    // 状态接口失败静默：不影响历史记录浏览
  } finally {
    statusLoading.value = false;
  }
}

async function loadRuns(): Promise<void> {
  runsLoading.value = true;
  try {
    runs.value = await tasksApi.runs(runsPage.value, runsPageSize.value);
  } catch {
    // 拦截器已提示
  } finally {
    runsLoading.value = false;
  }
}

async function loadSources(): Promise<void> {
  try {
    sources.value = await sourcesApi.list();
  } catch {
    // 手动采集下拉失败时，仍可留空表示采集全部启用源
  }
}

onMounted(async () => {
  await Promise.all([loadStatus(), loadRuns(), loadSources()]);
  // 若进入页面时已有运行中的任务，自动接续轮询，保证状态实时。
  const runningRunId = status.value?.runningRunId;
  if (runningRunId) {
    startPolling(runningRunId);
  }
});

/** 轮询定时器；任何时刻最多一个。 */
let pollTimer: ReturnType<typeof setInterval> | undefined;

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function pollRun(runId: number): Promise<void> {
  try {
    const run = await tasksApi.run(runId);
    activeRun.value = run;
    if (run.status !== 'running') {
      stopPolling();
      ElMessage.success(run.status === 'failed' ? '采集任务已结束（存在失败源）' : '采集任务已完成');
      await Promise.all([loadRuns(), loadStatus()]);
    }
  } catch {
    stopPolling();
  }
}

function startPolling(runId: number): void {
  stopPolling();
  void pollRun(runId);
  pollTimer = setInterval(() => {
    void pollRun(runId);
  }, 3000);
}

onBeforeUnmount(stopPolling);

function openFetchDialog(): void {
  selectedSourceKeys.value = [];
  fetchVisible.value = true;
}

async function startFetch(): Promise<void> {
  fetching.value = true;
  try {
    const input = selectedSourceKeys.value.length > 0 ? { sourceKeys: [...selectedSourceKeys.value] } : {};
    const result = await tasksApi.startFetch(input);
    ElMessage.success(`采集任务已启动（运行 #${result.runId}）`);
    fetchVisible.value = false;
    activeRun.value = null;
    await Promise.all([loadRuns(), loadStatus()]);
    startPolling(result.runId);
  } catch {
    // 拦截器已提示
  } finally {
    fetching.value = false;
  }
}

async function openRunDetail(run: RunDTO): Promise<void> {
  detailVisible.value = true;
  detailLoading.value = true;
  detailRun.value = run;
  try {
    detailRun.value = await tasksApi.run(run.id);
  } catch {
    // 拦截器已提示，先用列表行数据兜底展示
  } finally {
    detailLoading.value = false;
  }
}

/** 日志追加时自动滚到底部，便于跟踪长时间运行的任务。 */
watch(
  () => detailRun.value?.logs.length,
  async () => {
    await nextTick();
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight;
    }
  },
);

async function refreshDetail(): Promise<void> {
  if (!detailRun.value) return;
  detailLoading.value = true;
  try {
    detailRun.value = await tasksApi.run(detailRun.value.id);
  } catch {
    // 拦截器已提示
  } finally {
    detailLoading.value = false;
  }
}

function handleRunsPageChange(nextPage: number): void {
  runsPage.value = nextPage;
  void loadRuns();
}

function handleRunsSizeChange(nextSize: number): void {
  runsPageSize.value = nextSize;
  runsPage.value = 1;
  void loadRuns();
}

/** 顶部「刷新」：状态、历史与数据源列表一起更新，避免手动采集下拉使用过期数据。 */
async function refreshAll(): Promise<void> {
  await Promise.all([loadStatus(), loadRuns(), loadSources()]);
}
</script>

<template>
  <div class="page-container">
    <PageHeader title="采集任务" description="调度器状态、手动触发与历史运行记录">
      <template #actions>
        <el-button :icon="Refresh" :loading="statusLoading || runsLoading" @click="refreshAll">
          刷新
        </el-button>
        <el-button v-if="auth.isAdmin" type="primary" :icon="VideoPlay" @click="openFetchDialog"
          >立即采集</el-button
        >
      </template>
    </PageHeader>

    <div class="knet-card status-card">
      <div class="knet-card-header">
        <span class="knet-card-title">调度器状态</span>
        <div class="knet-inline">
          <el-tag :type="schedulerEnabled ? 'success' : 'info'" size="small" effect="light">
            {{ schedulerEnabled ? '调度已启用' : '调度已停用' }}
          </el-tag>
          <el-tag :type="schedulerRunning ? 'warning' : 'info'" size="small" effect="plain">
            {{ schedulerRunning ? '采集运行中' : '当前空闲' }}
          </el-tag>
        </div>
      </div>
      <div v-loading="statusLoading" class="status-body">
        <div class="status-metrics">
          <div class="status-metric">
            <div class="status-label">启用数据源</div>
            <div class="status-value">{{ enabledSourceCount }} / {{ totalSourceCount }}</div>
          </div>
          <div class="status-metric">
            <div class="status-label">下次自动调度</div>
            <div class="status-value status-value-sm">{{ formatDateTime(nextScheduledAt) }}</div>
          </div>
          <div class="status-metric">
            <div class="status-label">运行中的任务</div>
            <div class="status-value">{{ status?.runningRunId ? `#${status.runningRunId}` : '-' }}</div>
          </div>
        </div>

        <div v-if="(status?.jobs ?? []).length > 0" class="scheduler-jobs">
          <div class="next-due-title">定时任务</div>
          <div v-for="job in status?.jobs ?? []" :key="job.name" class="job-item">
            <span class="job-name">{{ job.name }}</span>
            <span class="job-cron knet-mono">{{ job.cron }}</span>
            <span class="due-time">下次 {{ formatDateTime(job.nextRunAt) }}</span>
          </div>
        </div>

        <div class="next-due">
          <div class="next-due-title">到期数据源（前 10 个）</div>
          <el-empty v-if="dueSources.length === 0" description="暂无到期数据源" :image-size="64" />
          <div v-for="source in dueSources" :key="source.key" class="due-item">
            <span class="due-name" :title="source.name">{{ source.name }}</span>
            <span class="due-key knet-mono">{{ source.key }}</span>
            <span class="due-interval">每 {{ source.intervalMinutes }} 分钟</span>
            <span class="due-time">应采集 {{ formatDateTime(source.dueAt) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="activeRun" class="knet-card running-card">
      <div class="running-head">
        <div class="knet-inline">
          <span class="knet-card-title">当前任务 #{{ activeRun.id }}</span>
          <el-tag :type="RUN_STATUS_META[activeRun.status].type" size="small" effect="light">
            {{ RUN_STATUS_META[activeRun.status].label }}
          </el-tag>
        </div>
        <div class="knet-inline">
          <span class="knet-muted">新增 {{ formatNumber(activeRun.itemsNew) }} 条</span>
          <el-button link type="primary" size="small" @click="openRunDetail(activeRun)">查看详情</el-button>
        </div>
      </div>
    </div>

    <div class="knet-card table-card">
      <div class="knet-card-header">
        <span class="knet-card-title">运行历史</span>
        <span class="knet-muted">共 {{ runs.total }} 次运行</span>
      </div>
      <el-table v-loading="runsLoading" :data="runs.items" row-key="id">
        <el-table-column label="运行" width="86">
          <template #default="{ row }"
            ><span class="run-id">#{{ row.id }}</span></template
          >
        </el-table-column>
        <el-table-column label="触发" width="88">
          <template #default="{ row }">{{ RUN_TRIGGER_LABELS[row.trigger as RunDTO['trigger']] }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="RUN_STATUS_META[row.status as RunDTO['status']].type" size="small" effect="light">
              {{ RUN_STATUS_META[row.status as RunDTO['status']].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="开始时间" width="160">
          <template #default="{ row }">{{ formatDateTime(row.startedAt) }}</template>
        </el-table-column>
        <el-table-column label="耗时" width="120">
          <template #default="{ row }">{{ formatDuration(row.startedAt, row.finishedAt) }}</template>
        </el-table-column>
        <el-table-column label="来源" width="110">
          <template #default="{ row }">
            <span :class="{ 'fail-text': row.sourcesFailed > 0 }">
              {{ row.sourcesOk }} / {{ row.sourcesTotal }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="新增" width="86">
          <template #default="{ row }">{{ formatNumber(row.itemsNew) }}</template>
        </el-table-column>
        <el-table-column label="去重" width="86">
          <template #default="{ row }">{{ formatNumber(row.itemsDuplicate) }}</template>
        </el-table-column>
        <el-table-column label="错误" min-width="200">
          <template #default="{ row }">
            <el-tooltip v-if="row.error" :content="row.error" placement="top">
              <span class="error-text">{{ row.error }}</span>
            </el-tooltip>
            <span v-else class="knet-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="86" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openRunDetail(row)">详情</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无运行记录，点击右上角「立即采集」开始第一次采集" :image-size="96" />
        </template>
      </el-table>
      <div class="table-footer">
        <el-pagination
          v-model:current-page="runsPage"
          v-model:page-size="runsPageSize"
          :total="runs.total"
          layout="total, prev, pager, next"
          background
          @current-change="handleRunsPageChange"
          @size-change="handleRunsSizeChange"
        />
      </div>
    </div>

    <el-dialog v-model="fetchVisible" title="立即采集" width="520px" :close-on-click-modal="false">
      <el-form label-position="top">
        <el-form-item label="选择数据源（不选则采集全部启用的数据源）">
          <el-select
            v-model="selectedSourceKeys"
            multiple
            filterable
            clearable
            collapse-tags
            collapse-tags-tooltip
            placeholder="全部启用的数据源"
            class="full-width"
          >
            <el-option
              v-for="source in enabledSources"
              :key="source.key"
              :label="source.name"
              :value="source.key"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="采集将在服务端串行执行，单源失败不会中断整轮；可在运行历史中查看日志。"
      />
      <template #footer>
        <el-button @click="fetchVisible = false">取消</el-button>
        <el-button type="primary" :loading="fetching" @click="startFetch">开始采集</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="detailVisible" :size="680" title="运行详情">
      <template v-if="detailRun">
        <div class="detail-head">
          <div class="knet-inline">
            <span class="detail-title">运行 #{{ detailRun.id }}</span>
            <el-tag :type="RUN_STATUS_META[detailRun.status].type" size="small" effect="light">
              {{ RUN_STATUS_META[detailRun.status].label }}
            </el-tag>
          </div>
          <el-button size="small" :loading="detailLoading" @click="refreshDetail">刷新</el-button>
        </div>
        <el-descriptions :column="2" border size="small" class="detail-desc">
          <el-descriptions-item label="触发方式">
            {{ RUN_TRIGGER_LABELS[detailRun.trigger] }}
          </el-descriptions-item>
          <el-descriptions-item label="耗时">
            {{ formatDuration(detailRun.startedAt, detailRun.finishedAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="开始时间">{{
            formatDateTime(detailRun.startedAt)
          }}</el-descriptions-item>
          <el-descriptions-item label="结束时间">{{
            formatDateTime(detailRun.finishedAt)
          }}</el-descriptions-item>
          <el-descriptions-item label="数据源">
            成功 {{ detailRun.sourcesOk }} / 失败 {{ detailRun.sourcesFailed }} / 共
            {{ detailRun.sourcesTotal }}
          </el-descriptions-item>
          <el-descriptions-item label="条目">
            新增 {{ formatNumber(detailRun.itemsNew) }} / 去重 {{ formatNumber(detailRun.itemsDuplicate) }}
          </el-descriptions-item>
          <el-descriptions-item label="错误" :span="2">
            {{ detailRun.error || '-' }}
          </el-descriptions-item>
        </el-descriptions>

        <div class="log-title">运行日志（{{ detailRun.logs.length }} 行）</div>
        <div ref="logContainer" v-loading="detailLoading" class="log-container knet-mono">
          <div v-if="detailRun.logs.length === 0" class="log-empty">暂无日志</div>
          <div v-for="(line, index) in detailRun.logs" :key="index" class="log-line">
            <span class="log-index">{{ index + 1 }}</span>
            <span class="log-text">{{ line }}</span>
          </div>
        </div>
      </template>
      <el-empty v-else description="暂无运行详情" />
    </el-drawer>
  </div>
</template>

<style scoped>
.status-card {
  margin-bottom: 14px;
}

.status-body {
  padding: 16px 18px;
}

.status-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 36px;
  padding-bottom: 16px;
  border-bottom: 1px solid #f1f5f9;
}

.status-label {
  font-size: 12px;
  color: var(--knet-text-secondary);
}

.status-value {
  margin-top: 6px;
  font-size: 22px;
  font-weight: 600;
  color: var(--knet-text);
  font-variant-numeric: tabular-nums;
}

.status-value-sm {
  font-size: 14px;
  font-weight: 500;
  line-height: 33px;
}

.next-due {
  padding-top: 14px;
}

.scheduler-jobs {
  padding-top: 14px;
}

.next-due-title {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--knet-text);
}

.due-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  font-size: 13px;
  border-radius: 6px;
}

.due-item:hover {
  background: #f8fafc;
}

.due-name {
  min-width: 0;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.due-key {
  font-size: 12px;
  color: var(--knet-text-muted);
}

.job-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  font-size: 13px;
  border-radius: 6px;
}

.job-item:hover {
  background: #f8fafc;
}

.job-name {
  font-weight: 500;
}

.job-cron {
  font-size: 12px;
  color: var(--knet-text-muted);
}

.due-interval {
  font-size: 12px;
  color: var(--knet-text-muted);
}

.due-time {
  margin-left: auto;
  font-size: 12px;
  color: var(--knet-text-secondary);
}

.running-card {
  margin-bottom: 14px;
  padding: 12px 18px;
}

.running-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.table-card {
  padding: 0 16px 12px;
}

.table-card .knet-card-header {
  padding-left: 0;
  padding-right: 0;
}

.run-id {
  font-weight: 600;
  color: var(--knet-text);
}

.fail-text {
  color: #dc2626;
}

.error-text {
  display: block;
  max-width: 260px;
  overflow: hidden;
  color: #dc2626;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
}

.full-width {
  width: 100%;
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.detail-title {
  font-size: 15px;
  font-weight: 600;
}

.detail-desc {
  margin-bottom: 18px;
}

.log-title {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
}

.log-container {
  height: 360px;
  padding: 10px 12px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.7;
  color: #cbd5e1;
  background: #0b1220;
  border-radius: 8px;
}

.log-line {
  display: flex;
  gap: 10px;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-index {
  width: 28px;
  flex-shrink: 0;
  color: #475569;
  text-align: right;
  user-select: none;
}

.log-text {
  flex: 1;
}

.log-empty {
  padding: 24px 0;
  color: #64748b;
  text-align: center;
}
</style>

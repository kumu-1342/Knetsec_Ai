<script setup lang="ts">
/**
 * 数据源管理。
 *
 * 运营在这里维护采集入口：启停、改配置、试采、增删。
 * 设计取舍：
 * - 数据源数量是「几十个」量级，前端一次性拉全量再本地筛选，比服务端分页更顺手；
 * - 试采走独立接口（不写库），结果用弹窗展示样本标题与耗时，避免误触发正式采集；
 * - 启用开关用受控模式（:model-value + @change），请求失败时开关不会停留在错误状态。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh } from '@element-plus/icons-vue';
import {
  ADAPTER_LABELS,
  SOURCE_CATEGORY_LABELS,
  type CreateSourceInput,
  type SourceDTO,
  type SourceTestResult,
  type SourceCategory,
} from '@knetsec/shared';
import { settingsApi, sourcesApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { formatDateTime, successRate } from '@/utils/format';
import { RUN_STATUS_META, SOURCE_CATEGORY_OPTIONS } from '@/utils/enums';
import PageHeader from '@/components/PageHeader.vue';
import SourceFormDialog from '@/components/SourceFormDialog.vue';

interface SourceFilters {
  q: string;
  category: SourceCategory | '';
  enabled: '' | 'true' | 'false';
}

const auth = useAuthStore();

const sources = ref<SourceDTO[]>([]);
const loading = ref(false);
const dialogVisible = ref(false);
const editingSource = ref<SourceDTO | null>(null);
const saving = ref(false);
const defaultInterval = ref(360);
const toggleLoadingId = ref<number | null>(null);
const testLoadingId = ref<number | null>(null);
const testVisible = ref(false);
const testResult = ref<SourceTestResult | null>(null);
const testSourceName = ref('');
const filters = ref<SourceFilters>({ q: '', category: '', enabled: '' });

const filteredSources = computed(() => {
  const keyword = filters.value.q.trim().toLowerCase();
  return sources.value.filter((source) => {
    if (keyword && !`${source.name} ${source.key}`.toLowerCase().includes(keyword)) return false;
    if (filters.value.category && source.category !== filters.value.category) return false;
    if (filters.value.enabled === 'true' && !source.enabled) return false;
    if (filters.value.enabled === 'false' && source.enabled) return false;
    return true;
  });
});

const enabledCount = computed(() => sources.value.filter((source) => source.enabled).length);
const failedCount = computed(() => sources.value.filter((source) => source.lastStatus === 'failed').length);

async function loadSources(): Promise<void> {
  loading.value = true;
  try {
    sources.value = await sourcesApi.list();
  } catch {
    // 拦截器已提示
  } finally {
    loading.value = false;
  }
}

/** 读取系统设置作为「新建数据源」的默认采集间隔；失败不影响主流程。 */
async function loadDefaultInterval(): Promise<void> {
  try {
    const settings = await settingsApi.get();
    defaultInterval.value = settings.fetchIntervalMinutes;
  } catch {
    // 保持内置默认值 360 分钟
  }
}

onMounted(() => {
  void loadSources();
  void loadDefaultInterval();
});

/** 上次运行状态标签：没有运行记录时返回 null。 */
function lastStatusMeta(
  source: SourceDTO,
): { label: string; type: 'primary' | 'success' | 'warning' | 'danger' | 'info' } | null {
  if (!source.lastStatus) return null;
  return RUN_STATUS_META[source.lastStatus];
}

function rateText(source: SourceDTO): string {
  const rate = successRate(source.successCount, source.failureCount);
  return rate === null ? '-' : `${rate}%`;
}

function openCreate(): void {
  editingSource.value = null;
  dialogVisible.value = true;
}

function openEdit(source: SourceDTO): void {
  editingSource.value = source;
  dialogVisible.value = true;
}

async function handleToggle(source: SourceDTO, value: boolean): Promise<void> {
  toggleLoadingId.value = source.id;
  try {
    const updated = await sourcesApi.setEnabled(source.id, value);
    source.enabled = updated.enabled;
    ElMessage.success(value ? `已启用「${source.name}」` : `已停用「${source.name}」`);
  } catch {
    // 拦截器已提示；受控开关不会改值，所以失败自动回到原状态
  } finally {
    toggleLoadingId.value = null;
  }
}

async function handleSubmit(payload: { id: number | null; input: CreateSourceInput }): Promise<void> {
  saving.value = true;
  try {
    if (payload.id === null) {
      await sourcesApi.create(payload.input);
      ElMessage.success('数据源创建成功');
    } else {
      await sourcesApi.update(payload.id, payload.input);
      ElMessage.success('数据源更新成功');
    }
    dialogVisible.value = false;
    await loadSources();
  } catch {
    // 拦截器已提示
  } finally {
    saving.value = false;
  }
}

async function handleDelete(source: SourceDTO): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除数据源「${source.name}」后不再采集，但已入库的历史情报会保留。是否继续？`,
      '删除数据源',
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await sourcesApi.remove(source.id);
    ElMessage.success('数据源已删除');
    await loadSources();
  } catch {
    // 拦截器已提示
  }
}

async function handleTest(source: SourceDTO): Promise<void> {
  testLoadingId.value = source.id;
  try {
    const result = await sourcesApi.test(source.id);
    testResult.value = result;
    testSourceName.value = source.name;
    testVisible.value = true;
  } catch {
    // 拦截器已提示
  } finally {
    testLoadingId.value = null;
  }
}
</script>

<template>
  <div class="page-container">
    <PageHeader
      title="数据源管理"
      :description="`共 ${sources.length} 个数据源，已启用 ${enabledCount} 个，最近失败 ${failedCount} 个`"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadSources">刷新</el-button>
        <el-button v-if="auth.isAdmin" type="primary" :icon="Plus" @click="openCreate">新建数据源</el-button>
      </template>
    </PageHeader>

    <div class="knet-card filter-card">
      <div class="knet-card-body">
        <div class="knet-toolbar">
          <el-input v-model="filters.q" class="knet-search" placeholder="搜索名称 / key" clearable />
          <el-select v-model="filters.category" placeholder="全部分类" clearable>
            <el-option
              v-for="option in SOURCE_CATEGORY_OPTIONS"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
          <el-select v-model="filters.enabled" placeholder="全部状态" clearable>
            <el-option label="已启用" value="true" />
            <el-option label="已停用" value="false" />
          </el-select>
        </div>
      </div>
    </div>

    <div class="knet-card table-card">
      <el-table v-loading="loading" :data="filteredSources" row-key="id">
        <el-table-column label="启用" width="78" align="center">
          <template #default="{ row }">
            <el-switch
              :model-value="row.enabled"
              :loading="toggleLoadingId === row.id"
              :disabled="!auth.isAdmin"
              @change="(value: string | number | boolean) => handleToggle(row, Boolean(value))"
            />
          </template>
        </el-table-column>
        <el-table-column label="数据源" min-width="220">
          <template #default="{ row }">
            <div class="source-name">{{ row.name }}</div>
            <div class="source-key knet-mono">{{ row.key }}</div>
          </template>
        </el-table-column>
        <el-table-column label="适配器" min-width="190">
          <template #default="{ row }">
            {{ ADAPTER_LABELS[row.adapter as SourceDTO['adapter']] }}
          </template>
        </el-table-column>
        <el-table-column label="分类" width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" type="info">
              {{ SOURCE_CATEGORY_LABELS[row.category as SourceDTO['category']] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="间隔" width="86" align="right">
          <template #default="{ row }">{{ row.intervalMinutes }} 分</template>
        </el-table-column>
        <el-table-column label="上次运行" min-width="190">
          <template #default="{ row }">
            <div class="last-run">
              <span>{{ formatDateTime(row.lastRunAt) }}</span>
              <el-tag
                v-if="lastStatusMeta(row)"
                :type="lastStatusMeta(row)?.type"
                size="small"
                effect="light"
              >
                {{ lastStatusMeta(row)?.label }}
              </el-tag>
            </div>
            <el-tooltip v-if="row.lastError" :content="row.lastError" placement="top">
              <span class="last-error">{{ row.lastError }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="成功率" width="130">
          <template #default="{ row }">
            <el-tooltip
              :content="`成功 ${row.successCount} 次 / 失败 ${row.failureCount} 次`"
              placement="top"
            >
              <span class="rate-text">{{ rateText(row) }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column v-if="auth.isAdmin" label="操作" width="204" fixed="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button
                link
                type="primary"
                size="small"
                :loading="testLoadingId === row.id"
                @click="handleTest(row)"
              >
                试采
              </el-button>
              <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
              <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无数据源，请先新建或检查筛选条件" :image-size="96" />
        </template>
      </el-table>
    </div>

    <SourceFormDialog
      v-model="dialogVisible"
      :source="editingSource"
      :saving="saving"
      :default-interval="defaultInterval"
      @submit="handleSubmit"
    />

    <el-dialog v-model="testVisible" :title="`试采结果 · ${testSourceName}`" width="560px">
      <template v-if="testResult">
        <el-alert
          :title="testResult.ok ? '试采成功（未写入数据库）' : '试采失败'"
          :type="testResult.ok ? 'success' : 'error'"
          :closable="false"
          show-icon
          class="test-alert"
        />
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item label="适配器">{{ ADAPTER_LABELS[testResult.adapter] }}</el-descriptions-item>
          <el-descriptions-item label="样本数">{{ testResult.fetched }}</el-descriptions-item>
          <el-descriptions-item label="耗时">{{ testResult.durationMs }} ms</el-descriptions-item>
        </el-descriptions>
        <div v-if="testResult.error" class="test-error knet-mono">{{ testResult.error }}</div>
        <template v-if="testResult.sample.length > 0">
          <div class="sample-title">样本标题（前 5 条）</div>
          <ol class="sample-list">
            <li v-for="(title, index) in testResult.sample" :key="index">{{ title }}</li>
          </ol>
        </template>
      </template>
      <template #footer>
        <el-button type="primary" @click="testVisible = false">知道了</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.filter-card {
  margin-bottom: 14px;
}

.table-card {
  padding: 4px 16px 12px;
}

.source-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--knet-text);
}

.source-key {
  margin-top: 2px;
  font-size: 12px;
  color: var(--knet-text-muted);
}

.last-run {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.last-error {
  display: block;
  max-width: 240px;
  margin-top: 2px;
  overflow: hidden;
  font-size: 12px;
  color: #dc2626;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rate-text {
  font-variant-numeric: tabular-nums;
  color: var(--knet-text-secondary);
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.test-alert {
  margin-bottom: 14px;
}

.test-error {
  margin-top: 12px;
  padding: 10px;
  font-size: 12px;
  color: #b91c1c;
  background: #fef2f2;
  border-radius: 8px;
  word-break: break-all;
}

.sample-title {
  margin: 16px 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--knet-text);
}

.sample-list {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.8;
  color: #374151;
}
</style>

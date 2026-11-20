<script setup lang="ts">
/**
 * 报告中心。
 *
 * 列表 + 生成入口。生成成功后直接跳转预览页，让运营第一时间确认成稿质量；
 * 下载由服务端返回文件流，前端只负责触发浏览器下载，不在前端拼 Markdown。
 */
import { onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import dayjs from 'dayjs';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh } from '@element-plus/icons-vue';
import {
  DEFAULT_PAGE_SIZE,
  REPORT_TYPE_LABELS,
  type GenerateReportInput,
  type Paginated,
  type ReportDTO,
  type ReportType,
} from '@knetsec/shared';
import { reportsApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { formatDate, formatDateTime, formatNumber, truncate } from '@/utils/format';
import { REPORT_TYPE_OPTIONS } from '@/utils/enums';
import PageHeader from '@/components/PageHeader.vue';

interface GenerateForm {
  type: ReportType;
  range: string[] | null;
  title: string;
}

const auth = useAuthStore();
const router = useRouter();

const reports = ref<Paginated<ReportDTO>>({
  items: [],
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
  totalPages: 0,
});
const page = ref(1);
const pageSize = ref(DEFAULT_PAGE_SIZE);
const typeFilter = ref<ReportType | ''>('');
const loading = ref(false);
const generateVisible = ref(false);
const generating = ref(false);
const downloadKey = ref('');
const form = reactive<GenerateForm>({ type: 'weekly', range: null, title: '' });

async function loadReports(): Promise<void> {
  loading.value = true;
  try {
    reports.value = await reportsApi.list({
      page: page.value,
      pageSize: pageSize.value,
      type: typeFilter.value || undefined,
    });
  } catch {
    // 拦截器已提示
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadReports();
});

watch(typeFilter, () => {
  page.value = 1;
  void loadReports();
});

function openGenerate(): void {
  form.type = 'weekly';
  form.range = null;
  form.title = '';
  generateVisible.value = true;
}

async function handleGenerate(): Promise<void> {
  if (form.type === 'custom' && (!form.range || form.range.length !== 2)) {
    ElMessage.error('生成自定义报告时请选择时间区间');
    return;
  }
  const input: GenerateReportInput = { type: form.type };
  if (form.range && form.range.length === 2) {
    const from = dayjs(form.range[0]).startOf('day');
    const to = dayjs(form.range[1]).endOf('day');
    if (from.isValid()) input.periodStart = from.toISOString();
    if (to.isValid()) input.periodEnd = to.toISOString();
  }
  if (form.title.trim()) input.title = form.title.trim();

  generating.value = true;
  try {
    const report = await reportsApi.generate(input);
    ElMessage.success('报告生成成功');
    generateVisible.value = false;
    await loadReports();
    if (report && typeof report.id === 'number') {
      await router.push(`/reports/${report.id}`);
    }
  } catch {
    // 拦截器已提示
  } finally {
    generating.value = false;
  }
}

async function handleDownload(report: ReportDTO, format: 'md' | 'html'): Promise<void> {
  downloadKey.value = `${report.id}-${format}`;
  try {
    await reportsApi.download(report.id, format, report.type);
    ElMessage.success(`已开始下载 ${format.toUpperCase()} 文件`);
  } catch {
    // 拦截器已提示
  } finally {
    downloadKey.value = '';
  }
}

async function handleDelete(report: ReportDTO): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除报告「${report.title}」后不可恢复，是否继续？`, '删除报告', {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    await reportsApi.remove(report.id);
    ElMessage.success('报告已删除');
    await loadReports();
  } catch {
    // 拦截器已提示
  }
}

function handlePageChange(nextPage: number): void {
  page.value = nextPage;
  void loadReports();
}

function handleSizeChange(nextSize: number): void {
  pageSize.value = nextSize;
  page.value = 1;
  void loadReports();
}
</script>

<template>
  <div class="page-container">
    <PageHeader
      title="报告中心"
      description="按日 / 周 / 月或自定义区间生成情报报告，支持 Markdown 与独立 HTML 下载"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadReports">刷新</el-button>
        <el-button v-if="auth.isAdmin" type="primary" :icon="Plus" @click="openGenerate">生成报告</el-button>
      </template>
    </PageHeader>

    <div class="knet-card filter-card">
      <div class="knet-card-body">
        <div class="knet-toolbar">
          <el-select v-model="typeFilter" placeholder="全部报告类型" clearable>
            <el-option
              v-for="option in REPORT_TYPE_OPTIONS"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
          <span class="knet-muted">共 {{ reports.total }} 份报告</span>
        </div>
      </div>
    </div>

    <div class="knet-card table-card">
      <el-table v-loading="loading" :data="reports.items" row-key="id">
        <el-table-column label="报告" min-width="300">
          <template #default="{ row }">
            <div class="report-title" :title="row.title" @click="router.push(`/reports/${row.id}`)">
              {{ row.title }}
            </div>
            <div class="report-preview">{{ truncate(row.preview, 96) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="96">
          <template #default="{ row }">
            <el-tag size="small" effect="light" type="primary">
              {{ REPORT_TYPE_LABELS[row.type as ReportType] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="报告区间" width="210">
          <template #default="{ row }">
            {{ formatDate(row.periodStart) }} ~ {{ formatDate(row.periodEnd) }}
          </template>
        </el-table-column>
        <el-table-column label="条目" width="80" align="right">
          <template #default="{ row }">{{ formatNumber(row.itemCount) }}</template>
        </el-table-column>
        <el-table-column label="生成人" width="110">
          <template #default="{ row }">{{ row.createdBy }}</template>
        </el-table-column>
        <el-table-column label="生成时间" width="160">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="270" fixed="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button link type="primary" size="small" @click="router.push(`/reports/${row.id}`)">
                预览
              </el-button>
              <el-button
                link
                type="primary"
                size="small"
                :loading="downloadKey === `${row.id}-md`"
                @click="handleDownload(row, 'md')"
              >
                MD
              </el-button>
              <el-button
                link
                type="primary"
                size="small"
                :loading="downloadKey === `${row.id}-html`"
                @click="handleDownload(row, 'html')"
              >
                HTML
              </el-button>
              <el-button v-if="auth.isAdmin" link type="danger" size="small" @click="handleDelete(row)">
                删除
              </el-button>
            </div>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无报告，点击右上角「生成报告」创建第一份" :image-size="96" />
        </template>
      </el-table>

      <div class="table-footer">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="reports.total"
          layout="total, sizes, prev, pager, next"
          background
          @current-change="handlePageChange"
          @size-change="handleSizeChange"
        />
      </div>
    </div>

    <el-dialog v-model="generateVisible" title="生成报告" width="560px" :close-on-click-modal="false">
      <el-form label-position="top">
        <el-form-item label="报告类型">
          <el-radio-group v-model="form.type">
            <el-radio-button v-for="option in REPORT_TYPE_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="报告区间（不选则按报告类型自动推断，例如周报=最近 7 天）">
          <el-date-picker
            v-model="form.range"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            class="full-width"
          />
        </el-form-item>
        <el-form-item label="报告标题（可选，留空自动生成）">
          <el-input
            v-model="form.title"
            placeholder="例如 Knetsec_Ai AI 安全周报（11 月第二周）"
            maxlength="120"
          />
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="报告会同步保存到数据库，生成后自动跳转预览页；下载的 HTML 为单文件，可直接浏览器打印为 PDF。"
      />
      <template #footer>
        <el-button @click="generateVisible = false">取消</el-button>
        <el-button type="primary" :loading="generating" @click="handleGenerate">生成并预览</el-button>
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

.report-title {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  color: var(--knet-text);
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.report-title:hover {
  color: var(--knet-primary);
}

.report-preview {
  margin-top: 3px;
  overflow: hidden;
  font-size: 12px;
  color: var(--knet-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.table-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
}

.full-width {
  width: 100%;
}
</style>

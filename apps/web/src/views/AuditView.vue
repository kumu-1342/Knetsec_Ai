<script setup lang="ts">
/**
 * 审计日志（仅管理员）。
 *
 * 写操作都会落库（登录、改设置、增删源、批量操作、生成报告等），这里提供分页与
 * 按用户/动作过滤，便于安全复盘；detail 字段以 JSON 弹窗展示原始上下文。
 */
import { onMounted, reactive, ref } from 'vue';
import { Refresh, Search } from '@element-plus/icons-vue';
import { DEFAULT_PAGE_SIZE, type AuditLogDTO, type Paginated } from '@knetsec/shared';
import { auditApi } from '@/api';
import { formatDateTime } from '@/utils/format';
import { AUDIT_ACTION_LABELS } from '@/utils/enums';
import PageHeader from '@/components/PageHeader.vue';

interface AuditFilters {
  username: string;
  action: string;
}

const filters = reactive<AuditFilters>({ username: '', action: '' });
const logs = ref<Paginated<AuditLogDTO>>({
  items: [],
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
  totalPages: 0,
});
const page = ref(1);
const pageSize = ref(DEFAULT_PAGE_SIZE);
const loading = ref(false);
const detailVisible = ref(false);
const detailLog = ref<AuditLogDTO | null>(null);

async function loadLogs(): Promise<void> {
  loading.value = true;
  try {
    logs.value = await auditApi.list({
      page: page.value,
      pageSize: pageSize.value,
      username: filters.username.trim() || undefined,
      action: filters.action.trim() || undefined,
    });
  } catch {
    // 拦截器已提示
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadLogs();
});

function handleSearch(): void {
  page.value = 1;
  void loadLogs();
}

function handleReset(): void {
  filters.username = '';
  filters.action = '';
  page.value = 1;
  void loadLogs();
}

function handlePageChange(nextPage: number): void {
  page.value = nextPage;
  void loadLogs();
}

function handleSizeChange(nextSize: number): void {
  pageSize.value = nextSize;
  page.value = 1;
  void loadLogs();
}

function actionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

function openDetail(log: AuditLogDTO): void {
  detailLog.value = log;
  detailVisible.value = true;
}

function formatDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return '{}';
  return JSON.stringify(detail, null, 2);
}
</script>

<template>
  <div class="page-container">
    <PageHeader title="审计日志" description="记录登录与全部写操作，用于安全复盘与责任追溯">
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadLogs">刷新</el-button>
      </template>
    </PageHeader>

    <div class="knet-card filter-card">
      <div class="knet-card-body">
        <div class="knet-toolbar">
          <el-input
            v-model="filters.username"
            placeholder="按用户名筛选"
            clearable
            class="knet-search"
            @keyup.enter="handleSearch"
          />
          <el-input
            v-model="filters.action"
            placeholder="按动作筛选，如 update_settings"
            clearable
            @keyup.enter="handleSearch"
          />
          <el-button type="primary" :icon="Search" @click="handleSearch">查询</el-button>
          <el-button text @click="handleReset">重置</el-button>
          <span class="knet-muted">共 {{ logs.total }} 条记录</span>
        </div>
      </div>
    </div>

    <div class="knet-card table-card">
      <el-table v-loading="loading" :data="logs.items" row-key="id">
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="用户" width="140">
          <template #default="{ row }">
            <span class="audit-user">{{ row.username || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="动作" width="170">
          <template #default="{ row }">
            <el-tooltip :content="row.action" placement="top">
              <el-tag size="small" effect="plain" type="primary">{{ actionLabel(row.action) }}</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="对象" min-width="180">
          <template #default="{ row }">
            <span class="knet-mono audit-target">{{ row.target || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="IP" width="150">
          <template #default="{ row }">{{ row.ip || '-' }}</template>
        </el-table-column>
        <el-table-column label="详情" width="100" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openDetail(row)">查看</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无审计记录" :image-size="96" />
        </template>
      </el-table>

      <div class="table-footer">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="logs.total"
          layout="total, sizes, prev, pager, next"
          background
          @current-change="handlePageChange"
          @size-change="handleSizeChange"
        />
      </div>
    </div>

    <el-dialog v-model="detailVisible" title="审计详情" width="580px">
      <template v-if="detailLog">
        <el-descriptions :column="2" border size="small" class="detail-desc">
          <el-descriptions-item label="时间">{{ formatDateTime(detailLog.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="用户">{{ detailLog.username }}</el-descriptions-item>
          <el-descriptions-item label="动作">{{ actionLabel(detailLog.action) }}</el-descriptions-item>
          <el-descriptions-item label="对象">{{ detailLog.target || '-' }}</el-descriptions-item>
          <el-descriptions-item label="IP" :span="2">{{ detailLog.ip || '-' }}</el-descriptions-item>
        </el-descriptions>
        <div class="detail-label">原始详情</div>
        <pre class="detail-json knet-mono">{{ formatDetail(detailLog.detail) }}</pre>
      </template>
      <template #footer>
        <el-button type="primary" @click="detailVisible = false">关闭</el-button>
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

.audit-user {
  font-weight: 500;
  color: var(--knet-text);
}

.audit-target {
  display: block;
  max-width: 260px;
  overflow: hidden;
  font-size: 12px;
  color: var(--knet-text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
}

.detail-desc {
  margin-bottom: 14px;
}

.detail-label {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
}

.detail-json {
  max-height: 320px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  color: #334155;
  background: #f8fafc;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>

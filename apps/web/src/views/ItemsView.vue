<script setup lang="ts">
/**
 * 情报中心。
 *
 * 页面结构：筛选工具栏 → 批量操作条 → 服务端分页表格 → 详情抽屉。
 * 几个刻意的设计：
 * - 关键词输入防抖 350ms，其他筛选立即生效，避免每敲一个字打一次接口；
 * - 所有筛选与分页都走服务端，前端不做二次过滤，保证「总数」与报告口径一致；
 * - viewer 角色隐藏选择列与批量/行内写操作（服务端也会 403，前端只是减少误点）；
 * - 导出复用当前筛选条件（去掉分页），导出前不改变列表状态。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import dayjs from 'dayjs';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDown, Refresh, Search } from '@element-plus/icons-vue';
import {
  DEFAULT_PAGE_SIZE,
  ITEM_CATEGORY_LABELS,
  UI_PAGE_SIZES,
  type BulkItemInput,
  type ItemCategory,
  type ItemDTO,
  type ItemListQuery,
  type Severity,
} from '@knetsec/shared';
import { itemsApi, sourcesApi, type ExportFormat } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { formatDateTime } from '@/utils/format';
import { CATEGORY_OPTIONS, SEVERITY_OPTIONS } from '@/utils/enums';
import PageHeader from '@/components/PageHeader.vue';
import SeverityTag from '@/components/SeverityTag.vue';
import ItemDetailDrawer from '@/components/ItemDetailDrawer.vue';

interface ItemFilters {
  q: string;
  sourceKey: string;
  category: ItemCategory | '';
  severity: Severity | '';
  read: '' | 'true' | 'false';
  starred: boolean;
  watched: boolean;
  /** el-date-picker 的 daterange 值：['YYYY-MM-DD', 'YYYY-MM-DD'] */
  range: string[] | null;
  sort: NonNullable<ItemListQuery['sort']>;
  order: 'asc' | 'desc';
}

interface SourceOption {
  key: string;
  name: string;
}

interface TableSortChange {
  prop: string;
  order: 'ascending' | 'descending' | null;
}

const auth = useAuthStore();

const filters = reactive<ItemFilters>({
  q: '',
  sourceKey: '',
  category: '',
  severity: '',
  read: '',
  starred: false,
  watched: false,
  range: null,
  sort: 'published_at',
  order: 'desc',
});

const page = ref(1);
const pageSize = ref(DEFAULT_PAGE_SIZE);
const pageSizes: number[] = [...UI_PAGE_SIZES];
const items = ref<ItemDTO[]>([]);
const total = ref(0);
const loading = ref(false);
const sources = ref<SourceOption[]>([]);
const selectedRows = ref<ItemDTO[]>([]);
const actionLoadingId = ref<number | null>(null);
const bulkLoading = ref(false);
const exportLoading = ref(false);
const detailVisible = ref(false);
const detailItem = ref<ItemDTO | null>(null);

const selectedIds = computed(() => selectedRows.value.map((row) => row.id));

/** 表格排序列 prop → 服务端排序字段。 */
const SORT_FIELD_MAP: Record<string, NonNullable<ItemListQuery['sort']>> = {
  publishedAt: 'published_at',
  fetchedAt: 'fetched_at',
  severity: 'severity',
  importance: 'importance',
};

const query = computed<ItemListQuery>(() => {
  const result: ItemListQuery = {
    page: page.value,
    pageSize: pageSize.value,
    sort: filters.sort,
    order: filters.order,
  };
  const keyword = filters.q.trim();
  if (keyword) result.q = keyword;
  if (filters.sourceKey) result.sourceKey = filters.sourceKey;
  if (filters.category) result.category = filters.category;
  if (filters.severity) result.severity = filters.severity;
  if (filters.read) result.read = filters.read === 'true';
  if (filters.starred) result.starred = true;
  if (filters.watched) result.watched = true;
  if (filters.range && filters.range.length === 2) {
    const [start, end] = filters.range;
    const from = dayjs(start).startOf('day');
    const to = dayjs(end).endOf('day');
    if (from.isValid()) result.from = from.toISOString();
    if (to.isValid()) result.to = to.toISOString();
  }
  return result;
});

async function loadItems(): Promise<void> {
  loading.value = true;
  try {
    const result = await itemsApi.list(query.value);
    items.value = result.items;
    total.value = result.total;
    selectedRows.value = [];
  } catch {
    // 错误提示已由 axios 拦截器统一弹出，这里保持旧数据避免页面闪空。
  } finally {
    loading.value = false;
  }
}

async function loadSources(): Promise<void> {
  try {
    const list = await sourcesApi.list();
    sources.value = list.map((source) => ({ key: source.key, name: source.name }));
  } catch {
    // 来源下拉失败不影响情报列表使用。
  }
}

onMounted(() => {
  void loadItems();
  void loadSources();
});

/** 关键词防抖：输入结束后再请求，避免逐字触发表格刷新。 */
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => filters.q,
  () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      page.value = 1;
      void loadItems();
    }, 350);
  },
);

/** 其他筛选条件变化立即回到第一页查询。 */
watch(
  () => [
    filters.sourceKey,
    filters.category,
    filters.severity,
    filters.read,
    filters.starred,
    filters.watched,
    filters.range,
    filters.sort,
    filters.order,
  ],
  () => {
    page.value = 1;
    void loadItems();
  },
  { deep: true },
);

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});

function categoryLabel(category: ItemCategory): string {
  return ITEM_CATEGORY_LABELS[category];
}

function resetFilters(): void {
  filters.q = '';
  filters.sourceKey = '';
  filters.category = '';
  filters.severity = '';
  filters.read = '';
  filters.starred = false;
  filters.watched = false;
  filters.range = null;
  filters.sort = 'published_at';
  filters.order = 'desc';
  page.value = 1;
  void loadItems();
}

function handlePageChange(nextPage: number): void {
  page.value = nextPage;
  void loadItems();
}

function handleSizeChange(nextSize: number): void {
  pageSize.value = nextSize;
  page.value = 1;
  void loadItems();
}

function handleSortChange(sort: TableSortChange): void {
  if (!sort.prop || !sort.order) {
    filters.sort = 'published_at';
    filters.order = 'desc';
    return;
  }
  filters.sort = SORT_FIELD_MAP[sort.prop] ?? 'published_at';
  filters.order = sort.order === 'ascending' ? 'asc' : 'desc';
}

function handleSelectionChange(rows: ItemDTO[]): void {
  selectedRows.value = rows;
}

function openDetail(row: ItemDTO): void {
  detailItem.value = row;
  detailVisible.value = true;
}

/** 同步更新列表与抽屉中的同一条记录（两者引用同一对象，保持一致）。 */
function patchItem(row: ItemDTO, patch: Pick<ItemDTO, 'isRead'> | Pick<ItemDTO, 'isStarred'>): void {
  Object.assign(row, patch);
  if (detailItem.value?.id === row.id) {
    detailItem.value = { ...row };
  }
}

async function toggleRead(row: ItemDTO): Promise<void> {
  actionLoadingId.value = row.id;
  try {
    const nextRead = !row.isRead;
    await itemsApi.update(row.id, { isRead: nextRead });
    patchItem(row, { isRead: nextRead });
    ElMessage.success(nextRead ? '已标记为已读' : '已标记为未读');
  } catch {
    // 拦截器已提示
  } finally {
    actionLoadingId.value = null;
  }
}

async function toggleStar(row: ItemDTO): Promise<void> {
  actionLoadingId.value = row.id;
  try {
    const nextStarred = !row.isStarred;
    await itemsApi.update(row.id, { isStarred: nextStarred });
    patchItem(row, { isStarred: nextStarred });
    ElMessage.success(nextStarred ? '已加入星标' : '已取消星标');
  } catch {
    // 拦截器已提示
  } finally {
    actionLoadingId.value = null;
  }
}

async function handleBulk(action: BulkItemInput['action']): Promise<void> {
  const ids = selectedIds.value;
  if (ids.length === 0) return;
  if (action === 'delete') {
    try {
      await ElMessageBox.confirm(
        `将删除选中的 ${ids.length} 条情报，删除后不可恢复，是否继续？`,
        '批量删除',
        {
          confirmButtonText: '确认删除',
          cancelButtonText: '取消',
          type: 'warning',
        },
      );
    } catch {
      return;
    }
  }
  bulkLoading.value = true;
  try {
    await itemsApi.bulk({ ids, action });
    const actionLabelMap: Record<BulkItemInput['action'], string> = {
      mark_read: '标记已读',
      mark_unread: '标记未读',
      star: '星标',
      unstar: '取消星标',
      delete: '删除',
    };
    ElMessage.success(`已批量${actionLabelMap[action]} ${ids.length} 条`);
    // 删除后当前页可能为空，向前回退一页避免看到空列表。
    if (action === 'delete' && items.value.length === ids.length && page.value > 1) {
      page.value -= 1;
    }
    await loadItems();
  } catch {
    // 拦截器已提示
  } finally {
    bulkLoading.value = false;
  }
}

async function exportItems(format: ExportFormat): Promise<void> {
  exportLoading.value = true;
  try {
    const exportQuery: ItemListQuery = { ...query.value };
    delete exportQuery.page;
    delete exportQuery.pageSize;
    await itemsApi.exportItems(format, exportQuery);
    ElMessage.success('导出文件已开始下载');
  } catch {
    // 拦截器已提示
  } finally {
    exportLoading.value = false;
  }
}

function handleExportCommand(command: string | number | object): void {
  const format: ExportFormat = command === 'json' ? 'json' : command === 'markdown' ? 'markdown' : 'csv';
  void exportItems(format);
}

function handleDrawerToggleRead(): void {
  if (detailItem.value) void toggleRead(detailItem.value);
}

function handleDrawerToggleStar(): void {
  if (detailItem.value) void toggleStar(detailItem.value);
}
</script>

<template>
  <div class="page-container">
    <PageHeader
      title="情报中心"
      :description="`共 ${total} 条情报，支持关键词、来源、分类、严重度与时间筛选`"
    >
      <template #actions>
        <el-dropdown :disabled="exportLoading" @command="handleExportCommand">
          <el-button :loading="exportLoading">
            导出<el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="csv">导出 CSV</el-dropdown-item>
              <el-dropdown-item command="json">导出 JSON</el-dropdown-item>
              <el-dropdown-item command="markdown">导出 Markdown</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button :icon="Refresh" :loading="loading" @click="loadItems">刷新</el-button>
      </template>
    </PageHeader>

    <div class="knet-card filter-card">
      <div class="knet-card-body">
        <div class="knet-toolbar">
          <el-input
            v-model="filters.q"
            class="knet-search"
            placeholder="搜索标题 / 摘要 / CVE / 标签关键词"
            clearable
            :prefix-icon="Search"
          />
          <el-select v-model="filters.sourceKey" placeholder="全部来源" clearable filterable>
            <el-option v-for="source in sources" :key="source.key" :label="source.name" :value="source.key" />
          </el-select>
          <el-select v-model="filters.category" placeholder="全部分类" clearable>
            <el-option
              v-for="option in CATEGORY_OPTIONS"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
          <el-select v-model="filters.severity" placeholder="全部严重度" clearable>
            <el-option
              v-for="option in SEVERITY_OPTIONS"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
          <el-select v-model="filters.read" placeholder="全部状态" clearable>
            <el-option label="未读" value="false" />
            <el-option label="已读" value="true" />
          </el-select>
          <el-date-picker
            v-model="filters.range"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="发布时间起"
            end-placeholder="发布时间止"
            class="date-range"
          />
          <el-checkbox v-model="filters.starred">只看星标</el-checkbox>
          <el-checkbox v-model="filters.watched">只看关注</el-checkbox>
          <el-button text type="primary" @click="resetFilters">重置筛选</el-button>
        </div>
      </div>
    </div>

    <div v-if="auth.isAdmin && selectedRows.length > 0" class="knet-card bulk-bar">
      <span class="bulk-text">
        已选 <b>{{ selectedRows.length }}</b> 条
      </span>
      <div class="bulk-actions">
        <el-button size="small" :loading="bulkLoading" @click="handleBulk('mark_read')">标记已读</el-button>
        <el-button size="small" :loading="bulkLoading" @click="handleBulk('mark_unread')">标记未读</el-button>
        <el-button size="small" :loading="bulkLoading" @click="handleBulk('star')">星标</el-button>
        <el-button size="small" :loading="bulkLoading" @click="handleBulk('unstar')">取消星标</el-button>
        <el-button size="small" type="danger" plain :loading="bulkLoading" @click="handleBulk('delete')">
          删除
        </el-button>
      </div>
    </div>

    <div class="knet-card table-card">
      <el-table
        v-loading="loading"
        :data="items"
        row-key="id"
        @selection-change="handleSelectionChange"
        @sort-change="handleSortChange"
        @row-dblclick="openDetail"
      >
        <el-table-column v-if="auth.isAdmin" type="selection" width="46" />
        <el-table-column label="标题" min-width="320">
          <template #default="{ row }">
            <div class="title-cell">
              <span class="title-text" :title="row.title" @click="openDetail(row)">{{ row.title }}</span>
              <div class="title-meta">
                <span v-if="row.isKev" class="kev-flag">KEV</span>
                <span v-if="row.isStarred" class="star-flag">★</span>
                <span v-if="!row.isRead" class="unread-dot" title="未读" />
                <span class="title-source">{{ row.sourceName }}</span>
                <span v-if="row.tags.length > 0" class="title-tags">#{{ row.tags.join(' #') }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="分类" width="112">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" type="info">{{ categoryLabel(row.category) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="严重度" width="90">
          <template #default="{ row }">
            <SeverityTag :severity="row.severity" />
          </template>
        </el-table-column>
        <el-table-column label="CVSS" width="84" prop="cvss">
          <template #default="{ row }">
            <span class="cvss-text">{{ row.cvssScore === null ? '-' : row.cvssScore.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="KEV" width="72">
          <template #default="{ row }">
            <el-tag v-if="row.isKev" size="small" type="danger" effect="dark">KEV</el-tag>
            <span v-else class="knet-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="发布时间" width="160" prop="publishedAt" sortable="custom">
          <template #default="{ row }">{{ formatDateTime(row.publishedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="196" fixed="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button link type="primary" size="small" @click="openDetail(row)">详情</el-button>
              <template v-if="auth.isAdmin">
                <el-button
                  link
                  type="primary"
                  size="small"
                  :loading="actionLoadingId === row.id"
                  @click="toggleRead(row)"
                >
                  {{ row.isRead ? '未读' : '已读' }}
                </el-button>
                <el-button
                  link
                  type="warning"
                  size="small"
                  :loading="actionLoadingId === row.id"
                  @click="toggleStar(row)"
                >
                  {{ row.isStarred ? '取消星' : '星标' }}
                </el-button>
              </template>
            </div>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="没有符合筛选条件的情报，可尝试重置筛选或先触发采集" :image-size="96" />
        </template>
      </el-table>

      <div class="table-footer">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="pageSizes"
          layout="total, sizes, prev, pager, next, jumper"
          background
          @current-change="handlePageChange"
          @size-change="handleSizeChange"
        />
      </div>
    </div>

    <ItemDetailDrawer
      v-model="detailVisible"
      :item="detailItem"
      @toggle-read="handleDrawerToggleRead"
      @toggle-star="handleDrawerToggleStar"
    />
  </div>
</template>

<style scoped>
.filter-card {
  margin-bottom: 14px;
}

.date-range {
  width: 250px !important;
}

.bulk-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding: 10px 16px;
}

.bulk-text {
  font-size: 13px;
  color: var(--knet-text-secondary);
}

.bulk-text b {
  color: var(--knet-primary);
}

.bulk-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.table-card {
  padding: 4px 16px 12px;
}

.title-cell {
  min-width: 0;
}

.title-text {
  display: block;
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--knet-text);
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.title-text:hover {
  color: var(--knet-primary);
}

.title-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  overflow: hidden;
  font-size: 12px;
  color: var(--knet-text-muted);
  white-space: nowrap;
}

.title-source {
  flex-shrink: 0;
}

.title-tags {
  overflow: hidden;
  color: #7c3aed;
  text-overflow: ellipsis;
}

.kev-flag {
  padding: 0 5px;
  font-size: 11px;
  color: #b91c1c;
  background: #fee2e2;
  border-radius: 4px;
  flex-shrink: 0;
}

.star-flag {
  color: #f59e0b;
  flex-shrink: 0;
}

.unread-dot {
  width: 6px;
  height: 6px;
  background: #2563eb;
  border-radius: 50%;
  flex-shrink: 0;
}

.cvss-text {
  font-variant-numeric: tabular-nums;
  color: var(--knet-text-secondary);
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
</style>

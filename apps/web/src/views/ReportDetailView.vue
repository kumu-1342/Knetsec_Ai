<script setup lang="ts">
/**
 * 报告预览/详情页。
 *
 * 渲染链路：服务端 Markdown → marked → DOMPurify → v-html（见 MarkdownViewer）。
 * 打印：直接调用 window.print()，布局层已通过 @media print 隐藏侧边栏与顶栏，
 * 输出的 PDF 只保留报告正文。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowLeft, Download, Printer } from '@element-plus/icons-vue';
import { REPORT_TYPE_LABELS, type ReportDetailDTO } from '@knetsec/shared';
import { reportsApi } from '@/api';
import { formatDate, formatDateTime, formatNumber } from '@/utils/format';
import PageHeader from '@/components/PageHeader.vue';
import MarkdownViewer from '@/components/MarkdownViewer.vue';

const route = useRoute();
const router = useRouter();
const report = ref<ReportDetailDTO | null>(null);
const loading = ref(false);
const errorMessage = ref('');
const downloadKey = ref('');

const reportId = computed(() => Number(route.params.id));

async function loadReport(): Promise<void> {
  const id = reportId.value;
  if (!Number.isFinite(id) || id <= 0) {
    errorMessage.value = '报告 ID 无效';
    return;
  }
  loading.value = true;
  errorMessage.value = '';
  try {
    report.value = await reportsApi.detail(id);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '报告加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadReport();
});

// 从另一份报告直接切换 id 时（例如后续支持上一篇/下一篇）重新加载。
watch(reportId, () => {
  void loadReport();
});

async function handleDownload(format: 'md' | 'html'): Promise<void> {
  if (!report.value) return;
  downloadKey.value = format;
  try {
    await reportsApi.download(report.value.id, format, report.value.type);
    ElMessage.success(`已开始下载 ${format.toUpperCase()} 文件`);
  } catch {
    // 拦截器已提示
  } finally {
    downloadKey.value = '';
  }
}

function handlePrint(): void {
  window.print();
}
</script>

<template>
  <div class="page-container">
    <PageHeader
      :title="report?.title ?? '报告预览'"
      :description="
        report
          ? `${REPORT_TYPE_LABELS[report.type]} · ${formatDate(report.periodStart)} ~ ${formatDate(
              report.periodEnd,
            )} · ${formatNumber(report.itemCount)} 条情报 · ${report.createdBy} 生成于 ${formatDateTime(
              report.createdAt,
            )}`
          : '加载报告内容'
      "
    >
      <template #actions>
        <el-button :icon="ArrowLeft" @click="router.push('/reports')">返回列表</el-button>
        <el-button :icon="Download" :loading="downloadKey === 'md'" @click="handleDownload('md')">
          下载 MD
        </el-button>
        <el-button :icon="Download" :loading="downloadKey === 'html'" @click="handleDownload('html')">
          下载 HTML
        </el-button>
        <el-button type="primary" :icon="Printer" @click="handlePrint">打印</el-button>
      </template>
    </PageHeader>

    <el-result v-if="errorMessage && !report" icon="error" title="报告加载失败" :sub-title="errorMessage">
      <template #extra>
        <el-button @click="router.push('/reports')">返回报告中心</el-button>
        <el-button type="primary" @click="loadReport">重试</el-button>
      </template>
    </el-result>

    <div v-else class="knet-card report-card">
      <MarkdownViewer :markdown="report?.markdown ?? ''" :loading="loading" />
    </div>
  </div>
</template>

<style scoped>
.report-card {
  padding: 28px 40px 40px;
}

@media print {
  .report-card {
    padding: 0;
  }
}
</style>

<script setup lang="ts">
/**
 * 情报详情抽屉。
 *
 * 职责：把列表行里的完整字段、关联编号（CVE/GHSA）与原始快照集中展示，
 * 让运营在不跳转外部页面的情况下判断价值；写操作（已读/星标）由父页面调用 API，
 * 组件只发事件，保持「展示与数据变更分离」。
 */
import { computed } from 'vue';
import { ITEM_CATEGORY_LABELS, type ItemDTO } from '@knetsec/shared';
import { formatDateTime } from '@/utils/format';
import { useAuthStore } from '@/stores/auth';
import SeverityTag from './SeverityTag.vue';

interface Props {
  modelValue: boolean;
  item: ItemDTO | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'toggle-read'): void;
  (e: 'toggle-star'): void;
}>();

const auth = useAuthStore();

const categoryLabel = computed(() => (props.item ? ITEM_CATEGORY_LABELS[props.item.category] : '-'));
const langLabel = computed(() => {
  if (!props.item) return '-';
  const map: Record<string, string> = { zh: '中文', en: '英文', other: '其他' };
  return map[props.item.lang] ?? props.item.lang;
});
const cveLinks = computed(() =>
  (props.item?.cveIds ?? []).map((id) => ({
    id,
    url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(id)}`,
  })),
);
const ghsaLinks = computed(() =>
  (props.item?.ghsaIds ?? []).map((id) => ({
    id,
    url: `https://github.com/advisories/${encodeURIComponent(id)}`,
  })),
);
/** 原始快照：shared ItemDTO 未暴露 raw 字段，这里展示前端实际持有的全部字段，用于排障。 */
const rawJson = computed(() => (props.item ? JSON.stringify(props.item, null, 2) : ''));
</script>

<template>
  <el-drawer
    :model-value="props.modelValue"
    :size="560"
    :destroy-on-close="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <div v-if="props.item" class="drawer-title">
        <span class="drawer-title-text" :title="props.item.title">{{ props.item.title }}</span>
      </div>
      <span v-else>情报详情</span>
    </template>

    <template v-if="props.item">
      <div class="detail-summary">
        <div class="detail-badges">
          <SeverityTag :severity="props.item.severity" size="default" />
          <el-tag effect="plain" type="info" size="default">{{ categoryLabel }}</el-tag>
          <el-tag v-if="props.item.isKev" type="danger" effect="dark" size="default">KEV 在野利用</el-tag>
          <el-tag v-if="props.item.isRead" type="info" size="default">已读</el-tag>
          <el-tag v-else type="warning" size="default">未读</el-tag>
          <el-tag v-if="props.item.isStarred" type="success" size="default">已星标</el-tag>
        </div>

        <el-descriptions :column="2" border size="small" class="detail-desc">
          <el-descriptions-item label="来源">{{ props.item.sourceName }}</el-descriptions-item>
          <el-descriptions-item label="来源标识">
            <span class="knet-mono">{{ props.item.sourceKey }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="严重度">
            <SeverityTag :severity="props.item.severity" />
          </el-descriptions-item>
          <el-descriptions-item label="CVSS">
            {{ props.item.cvssScore === null ? '-' : props.item.cvssScore.toFixed(1) }}
          </el-descriptions-item>
          <el-descriptions-item label="重要性">{{ props.item.importance }}</el-descriptions-item>
          <el-descriptions-item label="语言">{{ langLabel }}</el-descriptions-item>
          <el-descriptions-item label="发布时间">{{
            formatDateTime(props.item.publishedAt)
          }}</el-descriptions-item>
          <el-descriptions-item label="抓取时间">{{
            formatDateTime(props.item.fetchedAt)
          }}</el-descriptions-item>
          <el-descriptions-item label="厂商">{{ props.item.vendor || '-' }}</el-descriptions-item>
          <el-descriptions-item label="作者">{{ props.item.author || '-' }}</el-descriptions-item>
        </el-descriptions>
      </div>

      <section class="detail-section">
        <h3 class="detail-section-title">摘要</h3>
        <p class="detail-summary-text">{{ props.item.summary || '该条目暂无摘要，可打开原文查看详情。' }}</p>
      </section>

      <section v-if="props.item.tags.length > 0" class="detail-section">
        <h3 class="detail-section-title">AI 安全标签</h3>
        <div class="tag-list">
          <el-tag v-for="tag in props.item.tags" :key="tag" type="primary" effect="light" size="small">
            {{ tag }}
          </el-tag>
        </div>
      </section>

      <section v-if="cveLinks.length > 0 || ghsaLinks.length > 0" class="detail-section">
        <h3 class="detail-section-title">关联编号</h3>
        <div class="id-list">
          <a
            v-for="link in cveLinks"
            :key="link.id"
            :href="link.url"
            target="_blank"
            rel="noopener noreferrer"
          >
            <el-tag type="danger" effect="plain" size="small">{{ link.id }}</el-tag>
          </a>
          <a
            v-for="link in ghsaLinks"
            :key="link.id"
            :href="link.url"
            target="_blank"
            rel="noopener noreferrer"
          >
            <el-tag type="warning" effect="plain" size="small">{{ link.id }}</el-tag>
          </a>
        </div>
      </section>

      <section v-if="props.item.url" class="detail-section">
        <h3 class="detail-section-title">原文链接</h3>
        <el-link :href="props.item.url" target="_blank" rel="noopener noreferrer" type="primary">
          {{ props.item.url }}
        </el-link>
      </section>

      <section class="detail-section">
        <el-collapse>
          <el-collapse-item title="原始信息（排障用）" name="raw">
            <pre class="raw-json knet-mono">{{ rawJson }}</pre>
          </el-collapse-item>
        </el-collapse>
      </section>
    </template>

    <template #footer>
      <div class="drawer-footer">
        <el-button @click="emit('update:modelValue', false)">关闭</el-button>
        <template v-if="auth.isAdmin && props.item">
          <el-button @click="emit('toggle-read')">{{
            props.item.isRead ? '标记未读' : '标记已读'
          }}</el-button>
          <el-button type="primary" @click="emit('toggle-star')">
            {{ props.item.isStarred ? '取消星标' : '星标' }}
          </el-button>
        </template>
      </div>
    </template>
  </el-drawer>
</template>

<style scoped>
.drawer-title {
  display: flex;
  align-items: center;
  min-width: 0;
}

.drawer-title-text {
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}

.detail-desc {
  margin-bottom: 18px;
}

.detail-section {
  margin-bottom: 20px;
}

.detail-section-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--knet-text);
}

.detail-summary-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.8;
  color: #374151;
  white-space: pre-wrap;
  word-break: break-word;
}

.tag-list,
.id-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.raw-json {
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

.drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>

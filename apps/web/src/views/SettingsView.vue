<script setup lang="ts">
/**
 * 系统设置。
 *
 * 设置项与 shared 的 SettingsDTO 一一对应，按业务分为 5 组，避免一屏堆几十个字段。
 * 关键细节：
 * - LLM API Key 服务端只返回脱敏值；若用户没有改动，提交时必须传空字符串表示「保持原值」，
 *   否则会把脱敏串当成新 Key 写入；
 * - viewer 只读：整个表单 disabled 且隐藏保存按钮（服务端同样会拒绝 PUT）。
 */
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, Select } from '@element-plus/icons-vue';
import { DEFAULT_SETTINGS, type SettingsDTO, type UpdateSettingsInput } from '@knetsec/shared';
import { settingsApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { CATEGORY_OPTIONS, NOTIFICATION_CHANNEL_OPTIONS } from '@/utils/enums';
import PageHeader from '@/components/PageHeader.vue';

const auth = useAuthStore();

/** 用默认设置深拷贝初始化，避免输入过程中污染 shared 的常量对象。 */
function createDefaultForm(): SettingsDTO {
  return {
    ...DEFAULT_SETTINGS,
    watchKeywords: [...DEFAULT_SETTINGS.watchKeywords],
    aiSecurityKeywords: [...DEFAULT_SETTINGS.aiSecurityKeywords],
    reportSections: [...DEFAULT_SETTINGS.reportSections],
  };
}

const form = reactive<SettingsDTO>(createDefaultForm());
const loading = ref(false);
const saving = ref(false);
const loaded = ref(false);
/** 服务端返回的脱敏 Key，用于判断用户是否改动过。 */
const maskedApiKey = ref('');

async function loadSettings(): Promise<void> {
  loading.value = true;
  try {
    const settings = await settingsApi.get();
    Object.assign(form, settings, {
      watchKeywords: [...settings.watchKeywords],
      aiSecurityKeywords: [...settings.aiSecurityKeywords],
      reportSections: [...settings.reportSections],
    });
    maskedApiKey.value = settings.llmApiKey;
    loaded.value = true;
  } catch {
    // 拦截器已提示
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadSettings();
});

/**
 * 计算需要提交的 LLM Key。
 *
 * 契约：空字符串表示保持原值。因此未修改（仍等于脱敏值）或用户清空输入框时都传空串。
 */
function resolveApiKey(): string {
  const value = form.llmApiKey.trim();
  if (!value) return '';
  if (value === maskedApiKey.value) return '';
  return value;
}

async function handleSave(): Promise<void> {
  if (!auth.isAdmin) return;
  if (!form.reportRangeDays || form.reportRangeDays < 1) {
    ElMessage.error('报告回看天数必须大于 0');
    return;
  }
  if (form.reportSections.length === 0) {
    ElMessage.error('报告章节至少保留一项');
    return;
  }
  if (form.notificationEnabled && !form.notificationWebhook.trim()) {
    ElMessage.error('启用通知后必须填写 Webhook 地址');
    return;
  }
  if (form.llmEnabled && !form.llmBaseUrl.trim()) {
    ElMessage.error('启用 LLM 增强后必须填写 Base URL');
    return;
  }

  const payload: UpdateSettingsInput = {
    ...form,
    watchKeywords: [...form.watchKeywords],
    aiSecurityKeywords: [...form.aiSecurityKeywords],
    reportSections: [...form.reportSections],
    llmApiKey: resolveApiKey(),
  };

  saving.value = true;
  try {
    const updated = await settingsApi.update(payload);
    Object.assign(form, updated, {
      watchKeywords: [...updated.watchKeywords],
      aiSecurityKeywords: [...updated.aiSecurityKeywords],
      reportSections: [...updated.reportSections],
    });
    maskedApiKey.value = updated.llmApiKey;
    ElMessage.success('系统设置已保存并生效');
  } catch {
    // 拦截器已提示
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="page-container">
    <PageHeader title="系统设置" description="关键词、报告、通知、LLM 与数据保留策略，保存后立即生效">
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadSettings">重新加载</el-button>
        <el-button v-if="auth.isAdmin" type="primary" :icon="Select" :loading="saving" @click="handleSave">
          保存设置
        </el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="!auth.isAdmin"
      type="info"
      :closable="false"
      show-icon
      class="readonly-alert"
      title="当前账号为只读用户，仅可查看设置，修改需管理员权限。"
    />

    <el-form
      v-loading="loading"
      :model="form"
      :disabled="!auth.isAdmin || !loaded"
      label-width="150px"
      label-position="left"
      class="settings-form"
    >
      <div class="knet-card settings-card">
        <div class="knet-card-header">
          <span class="knet-card-title">关键词与打标</span>
          <span class="knet-muted">影响情报筛选、AI 安全标签与报告导语</span>
        </div>
        <div class="knet-card-body">
          <el-form-item label="重点关注关键词">
            <el-select
              v-model="form.watchKeywords"
              multiple
              filterable
              allow-create
              default-first-option
              placeholder="输入关键词后回车新增，例如 openai"
              class="full-width"
            />
            <div class="field-hint">命中关键词的情报会标记为「重点关注」，并影响 importance 评分。</div>
          </el-form-item>
          <el-form-item label="AI 安全关键词">
            <el-select
              v-model="form.aiSecurityKeywords"
              multiple
              filterable
              allow-create
              default-first-option
              placeholder="输入关键词后回车新增，例如 prompt injection"
              class="full-width"
            />
            <div class="field-hint">用于自动把情报归入「AI 安全」分类并打标签，建议与领域词典保持一致。</div>
          </el-form-item>
        </div>
      </div>

      <div class="knet-card settings-card">
        <div class="knet-card-header">
          <span class="knet-card-title">报告设置</span>
        </div>
        <div class="knet-card-body">
          <el-form-item label="默认回看天数">
            <el-input-number v-model="form.reportRangeDays" :min="1" :max="90" />
            <div class="field-hint">生成报告未指定区间时，按该天数回看；周报默认 7 天。</div>
          </el-form-item>
          <el-form-item label="报告章节">
            <el-checkbox-group v-model="form.reportSections" class="section-group">
              <el-checkbox v-for="option in CATEGORY_OPTIONS" :key="option.value" :value="option.value">
                {{ option.label }}
              </el-checkbox>
            </el-checkbox-group>
            <div class="field-hint">仅生成勾选的章节；建议至少保留「AI 安全」与「漏洞与补丁」。</div>
          </el-form-item>
        </div>
      </div>

      <div class="knet-card settings-card">
        <div class="knet-card-header">
          <span class="knet-card-title">通知</span>
        </div>
        <div class="knet-card-body">
          <el-form-item label="启用通知">
            <el-switch v-model="form.notificationEnabled" />
          </el-form-item>
          <el-form-item label="通知渠道">
            <el-select v-model="form.notificationChannel" class="channel-select">
              <el-option
                v-for="option in NOTIFICATION_CHANNEL_OPTIONS"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="Webhook 地址">
            <el-input v-model="form.notificationWebhook" placeholder="https://..." clearable />
            <div class="field-hint">
              采集到 critical / KEV 条目时推送 JSON 消息；企业微信、钉钉、飞书机器人请填写对应 Webhook。
            </div>
          </el-form-item>
        </div>
      </div>

      <div class="knet-card settings-card">
        <div class="knet-card-header">
          <span class="knet-card-title">LLM 摘要增强</span>
          <el-tag size="small" type="warning" effect="light">可选</el-tag>
        </div>
        <div class="knet-card-body">
          <el-form-item label="启用 LLM 增强">
            <el-switch v-model="form.llmEnabled" />
          </el-form-item>
          <el-form-item label="Base URL">
            <el-input v-model="form.llmBaseUrl" placeholder="https://api.deepseek.com" />
          </el-form-item>
          <el-form-item label="API Key">
            <el-input
              v-model="form.llmApiKey"
              type="password"
              show-password
              placeholder="留空表示保持原值；服务端仅返回脱敏 Key"
            />
            <div v-if="maskedApiKey" class="field-hint">当前已配置：{{ maskedApiKey }}</div>
          </el-form-item>
          <el-form-item label="模型">
            <el-input v-model="form.llmModel" placeholder="deepseek-chat" />
          </el-form-item>
          <div class="field-hint block-hint">
            开启后仅对 critical / high 条目生成 80 字中文摘要，超时 20 秒自动跳过，不阻塞采集流水线。
          </div>
        </div>
      </div>

      <div class="knet-card settings-card">
        <div class="knet-card-header">
          <span class="knet-card-title">数据保留与采集</span>
        </div>
        <div class="knet-card-body">
          <el-form-item label="情报保留天数">
            <el-input-number v-model="form.retentionDays" :min="7" :max="3650" />
            <div class="field-hint">超期数据由每日维护任务清理；报告文件不随条目删除。</div>
          </el-form-item>
          <el-form-item label="默认采集间隔">
            <el-input-number v-model="form.fetchIntervalMinutes" :min="5" :max="10080" :step="30" />
            <div class="field-hint">单位为分钟，仅作为新建数据源的默认值，已有数据源不受影响。</div>
          </el-form-item>
        </div>
      </div>
    </el-form>
  </div>
</template>

<style scoped>
.readonly-alert {
  margin-bottom: 14px;
}

.settings-form {
  max-width: 980px;
}

.settings-card {
  margin-bottom: 16px;
}

.full-width {
  width: 100%;
}

.channel-select {
  width: 280px;
}

.section-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
}

.field-hint {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--knet-text-muted);
}

.block-hint {
  padding-left: 0;
}
</style>

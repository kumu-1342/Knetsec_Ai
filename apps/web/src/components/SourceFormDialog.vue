<script setup lang="ts">
/**
 * 数据源新建/编辑对话框。
 *
 * 关键约束：
 * - adapter 的 config 是自由 JSON，必须在前端做语法与「对象」校验，避免把非法配置写库；
 * - 编辑时 key 与 adapter 禁用（契约规定一般不允许修改），防止历史条目与源对应关系错乱；
 * - 提供各适配器的配置模板，运营点击即可得到可运行的最小配置，降低录入成本。
 */
import { reactive, ref, watch } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import type { AdapterId, CreateSourceInput, SourceCategory, SourceDTO } from '@knetsec/shared';
import { ADAPTER_CONFIG_TEMPLATES, ADAPTER_OPTIONS, SOURCE_CATEGORY_OPTIONS } from '@/utils/enums';

interface Props {
  modelValue: boolean;
  /** 传入表示编辑，null 表示新建 */
  source: SourceDTO | null;
  saving?: boolean;
  /** 新建时的默认采集间隔（来自系统设置 fetchIntervalMinutes） */
  defaultInterval?: number;
}

interface SourceFormModel {
  key: string;
  name: string;
  category: SourceCategory;
  adapter: AdapterId;
  url: string;
  intervalMinutes: number;
  priority: number;
  enabled: boolean;
}

const props = withDefaults(defineProps<Props>(), { saving: false, defaultInterval: 360 });
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'submit', payload: { id: number | null; input: CreateSourceInput }): void;
}>();

const formRef = ref<FormInstance>();
const form = reactive<SourceFormModel>({
  key: '',
  name: '',
  category: 'github',
  adapter: 'github_advisories',
  url: '',
  intervalMinutes: 360,
  priority: 100,
  enabled: true,
});
const configText = ref('');
const configError = ref('');

const rules: FormRules<SourceFormModel> = {
  key: [
    { required: true, message: '请输入数据源 key', trigger: 'blur' },
    {
      pattern: /^[a-z0-9][a-z0-9-]{1,63}$/,
      message: '仅限小写字母、数字与中划线，2-64 位且以字母或数字开头',
      trigger: 'blur',
    },
  ],
  name: [{ required: true, message: '请输入数据源名称', trigger: 'blur' }],
  category: [{ required: true, message: '请选择分类', trigger: 'change' }],
  adapter: [{ required: true, message: '请选择适配器', trigger: 'change' }],
  intervalMinutes: [{ required: true, message: '请输入采集间隔', trigger: 'blur' }],
};

const isEditing = ref(false);

/** 用当前 source/默认值重置表单（每次打开对话框都执行，避免上一次的脏数据残留）。 */
function resetForm(): void {
  const source = props.source;
  isEditing.value = source !== null;
  form.key = source?.key ?? '';
  form.name = source?.name ?? '';
  form.category = source?.category ?? 'github';
  form.adapter = source?.adapter ?? 'github_advisories';
  form.url = source?.url ?? '';
  form.intervalMinutes = source?.intervalMinutes ?? props.defaultInterval;
  form.priority = source?.priority ?? 100;
  form.enabled = source?.enabled ?? true;
  configText.value = JSON.stringify(
    source?.config ?? JSON.parse(ADAPTER_CONFIG_TEMPLATES[form.adapter]),
    null,
    2,
  );
  configError.value = '';
  formRef.value?.clearValidate();
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) resetForm();
  },
  { immediate: true },
);

/** 切换适配器时，新建场景自动换成对应模板；编辑场景保留原配置。 */
function handleAdapterChange(adapter: AdapterId): void {
  if (isEditing.value) return;
  configText.value = ADAPTER_CONFIG_TEMPLATES[adapter];
  configError.value = '';
}

function fillTemplate(): void {
  configText.value = ADAPTER_CONFIG_TEMPLATES[form.adapter];
  configError.value = '';
}

/** 校验并解析 config JSON；返回 null 表示校验失败（错误文案已写入 configError）。 */
function parseConfig(): Record<string, unknown> | null {
  const text = configText.value.trim();
  if (!text) {
    configError.value = '';
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      configError.value = '配置必须是 JSON 对象（以 { 开头、以 } 结尾）';
      return null;
    }
    configError.value = '';
    return parsed as Record<string, unknown>;
  } catch (error) {
    configError.value = `JSON 语法错误：${error instanceof Error ? error.message : '无法解析'}`;
    return null;
  }
}

function close(): void {
  emit('update:modelValue', false);
}

async function handleSubmit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  const config = parseConfig();
  if (config === null) {
    ElMessage.error('请先修正 JSON 配置');
    return;
  }
  const input: CreateSourceInput = {
    key: form.key.trim(),
    name: form.name.trim(),
    category: form.category,
    adapter: form.adapter,
    config,
    enabled: form.enabled,
    intervalMinutes: form.intervalMinutes,
    priority: form.priority,
  };
  if (form.url.trim()) {
    input.url = form.url.trim();
  }
  emit('submit', { id: props.source?.id ?? null, input });
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    :title="isEditing ? '编辑数据源' : '新建数据源'"
    width="680px"
    top="6vh"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="104px" @submit.prevent>
      <el-row :gutter="16">
        <el-col :span="12">
          <el-form-item label="数据源 key" prop="key">
            <el-input v-model="form.key" :disabled="isEditing" placeholder="例如 github-ghsa" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="名称" prop="name">
            <el-input v-model="form.name" placeholder="例如 GitHub 安全公告库" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="分类" prop="category">
            <el-select v-model="form.category" class="full-width">
              <el-option
                v-for="option in SOURCE_CATEGORY_OPTIONS"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="适配器" prop="adapter">
            <el-select
              v-model="form.adapter"
              class="full-width"
              :disabled="isEditing"
              @change="handleAdapterChange"
            >
              <el-option
                v-for="option in ADAPTER_OPTIONS"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="24">
          <el-form-item label="入口地址">
            <el-input v-model="form.url" placeholder="https://...（排障用，可留空）" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="采集间隔" prop="intervalMinutes">
            <el-input-number
              v-model="form.intervalMinutes"
              :min="5"
              :max="10080"
              :step="30"
              class="full-width"
            />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="优先级">
            <el-input-number v-model="form.priority" :min="1" :max="999" class="full-width" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="启用">
            <el-switch v-model="form.enabled" />
          </el-form-item>
        </el-col>
      </el-row>

      <el-form-item label="适配器配置" class="config-item">
        <div class="config-header">
          <span class="config-hint">JSON 对象；不同适配器的字段见 docs/04-数据源接入与采集设计.md</span>
          <el-button size="small" text type="primary" @click="fillTemplate">填入示例配置</el-button>
        </div>
        <el-input
          v-model="configText"
          type="textarea"
          :rows="10"
          spellcheck="false"
          class="config-textarea"
          placeholder="{}"
          @input="configError = ''"
        />
        <div v-if="configError" class="config-error">{{ configError }}</div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :loading="props.saving" @click="handleSubmit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.full-width {
  width: 100%;
}

.config-item :deep(.el-form-item__content) {
  flex-direction: column;
  align-items: stretch;
}

.config-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  margin-bottom: 6px;
}

.config-hint {
  font-size: 12px;
  color: var(--knet-text-secondary);
}

.config-textarea :deep(textarea) {
  font-family: 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
}

.config-error {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.4;
  color: #dc2626;
}
</style>

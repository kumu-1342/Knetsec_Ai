<script setup lang="ts">
/**
 * 修改密码对话框。
 *
 * 放在布局层而不是设置页：管理员初始密码登录后（mustChangePassword=true）需要
 * 在任何页面都能快速改密，同时作为用户菜单的常规入口。
 */
import { reactive, ref, watch } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { useAuthStore } from '@/stores/auth';

interface Props {
  modelValue: boolean;
}

interface PasswordForm {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  /** 修改成功，布局层据此退出登录并跳转 */
  (e: 'success'): void;
}>();

const auth = useAuthStore();
const formRef = ref<FormInstance>();
const saving = ref(false);
const form = reactive<PasswordForm>({ oldPassword: '', newPassword: '', confirmPassword: '' });

const rules: FormRules<PasswordForm> = {
  oldPassword: [{ required: true, message: '请输入当前密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback: (error?: Error) => void) => {
        if (value.length < 8 || value.length > 64) {
          callback(new Error('密码长度需为 8-64 位'));
          return;
        }
        // 与服务端 validatePasswordStrength 保持一致，避免提交后才报错。
        if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
          callback(new Error('密码需同时包含字母和数字'));
          return;
        }
        callback();
      },
      trigger: 'blur',
    },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback: (error?: Error) => void) => {
        if (value !== form.newPassword) {
          callback(new Error('两次输入的新密码不一致'));
          return;
        }
        callback();
      },
      trigger: 'blur',
    },
  ],
};

function resetForm(): void {
  form.oldPassword = '';
  form.newPassword = '';
  form.confirmPassword = '';
  formRef.value?.clearValidate();
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) resetForm();
  },
);

function close(): void {
  emit('update:modelValue', false);
}

async function handleSubmit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  saving.value = true;
  try {
    await auth.changePassword({ oldPassword: form.oldPassword, newPassword: form.newPassword });
    ElMessage.success('密码已修改，请使用新密码重新登录');
    close();
    emit('success');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    title="修改密码"
    width="440px"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="90px" @submit.prevent>
      <el-form-item label="当前密码" prop="oldPassword">
        <el-input v-model="form.oldPassword" type="password" show-password autocomplete="current-password" />
      </el-form-item>
      <el-form-item label="新密码" prop="newPassword">
        <el-input
          v-model="form.newPassword"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="8-64 位，建议包含字母与数字"
        />
      </el-form-item>
      <el-form-item label="确认密码" prop="confirmPassword">
        <el-input
          v-model="form.confirmPassword"
          type="password"
          show-password
          autocomplete="new-password"
          @keyup.enter="handleSubmit"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :loading="saving" @click="handleSubmit">确认修改</el-button>
    </template>
  </el-dialog>
</template>

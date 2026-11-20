<script setup lang="ts">
/**
 * 登录页。
 *
 * 交互约定：
 * - 表单错误用行内提示而不是只弹 toast，方便用户看到具体原因；
 * - 登录请求传 silent=true，避免 axios 全局提示与行内提示重复；
 * - 登录成功后若 mustChangePassword 为 true，立刻提示去改密（布局层还有常驻横幅兜底）；
 * - redirect 参数仅接受站内路径，防止被利用做开放重定向。
 */
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { Lock, User } from '@element-plus/icons-vue';
import { APP_NAME, APP_TAGLINE, type LoginRequest } from '@knetsec/shared';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const formRef = ref<FormInstance>();
const form = reactive<LoginRequest>({ username: '', password: '' });
const errorMessage = ref('');

const rules: FormRules<LoginRequest> = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
};

/** 登录成功后的回跳地址：只允许站内绝对路径。 */
function resolveRedirect(): string {
  const redirect = route.query.redirect;
  if (typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//')) {
    return redirect;
  }
  return '/dashboard';
}

async function handleLogin(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  errorMessage.value = '';
  try {
    const response = await auth.login({ ...form }, true);
    if (response.user.mustChangePassword) {
      ElMessage.warning('当前账号使用初始密码，登录后请尽快修改');
    } else {
      ElMessage.success(`欢迎回来，${response.user.displayName}`);
    }
    await router.replace(resolveRedirect());
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '登录失败，请稍后重试';
  }
}
</script>

<template>
  <div class="login-page">
    <aside class="login-brand">
      <div class="brand-top">
        <div class="brand-mark">K</div>
        <div>
          <div class="brand-name">{{ APP_NAME }}</div>
          <div class="brand-tagline">{{ APP_TAGLINE }}</div>
        </div>
      </div>

      <div class="brand-copy">
        <h1>把 AI 安全情报<br />变成可运营的日常</h1>
        <p>多源采集 · 自动去重打标 · 一键成稿，运营只需要做判断与点评。</p>
        <ul class="brand-features">
          <li><span class="feature-dot" />覆盖 GitHub / NVD / CNVD / CISA KEV / MSRC / arXiv / 厂商博客</li>
          <li><span class="feature-dot" />同一 CVE / GHSA 自动去重，KEV 在野利用优先提醒</li>
          <li><span class="feature-dot" />日 / 周 / 月报一键生成，Markdown 与独立 HTML 双份交付</li>
        </ul>
      </div>

      <div class="brand-footer">Knetsec_Ai · 实时情报平台 · v1.0</div>
    </aside>

    <main class="login-main">
      <div class="login-card">
        <h2 class="login-title">登录管理面板</h2>
        <p class="login-subtitle">请使用管理员或只读账号登录</p>

        <el-alert
          v-if="errorMessage"
          :title="errorMessage"
          type="error"
          show-icon
          :closable="false"
          class="login-error"
        />

        <el-form ref="formRef" :model="form" :rules="rules" label-position="top" size="large" @submit.prevent>
          <el-form-item label="用户名" prop="username">
            <el-input
              v-model="form.username"
              :prefix-icon="User"
              placeholder="请输入用户名"
              autocomplete="username"
              autofocus
            />
          </el-form-item>
          <el-form-item label="密码" prop="password">
            <el-input
              v-model="form.password"
              :prefix-icon="Lock"
              type="password"
              show-password
              placeholder="请输入密码"
              autocomplete="current-password"
              @keyup.enter="handleLogin"
            />
          </el-form-item>
          <el-button
            type="primary"
            size="large"
            class="login-button"
            :loading="auth.loginLoading"
            @click="handleLogin"
          >
            登录
          </el-button>
        </el-form>

        <p class="login-hint">首次部署请使用服务端初始化的管理员账号登录，并立即修改密码。</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  min-height: 100vh;
  background: #f5f7fa;
}

/* 左侧品牌区：深色渐变，窄屏隐藏，保证登录表单在 1366 宽度下有足够空间。 */
.login-brand {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  width: 46%;
  max-width: 660px;
  padding: 44px 52px;
  color: #e2e8f0;
  background:
    radial-gradient(circle at 20% 10%, rgba(37, 99, 235, 0.35), transparent 45%),
    radial-gradient(circle at 85% 85%, rgba(124, 58, 237, 0.28), transparent 50%), #0b1220;
}

.brand-top {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  font-size: 22px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #2563eb, #7c3aed);
  border-radius: 12px;
}

.brand-name {
  font-size: 18px;
  font-weight: 600;
  color: #f8fafc;
}

.brand-tagline {
  margin-top: 2px;
  font-size: 13px;
  color: #94a3b8;
}

.brand-copy h1 {
  margin: 0 0 16px;
  font-size: 34px;
  font-weight: 700;
  line-height: 1.35;
  color: #f8fafc;
}

.brand-copy p {
  margin: 0 0 28px;
  font-size: 14px;
  line-height: 1.8;
  color: #94a3b8;
}

.brand-features {
  margin: 0;
  padding: 0;
  list-style: none;
}

.brand-features li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 14px;
  font-size: 13px;
  line-height: 1.7;
  color: #cbd5e1;
}

.feature-dot {
  width: 6px;
  height: 6px;
  margin-top: 7px;
  flex-shrink: 0;
  background: #3b82f6;
  border-radius: 50%;
}

.brand-footer {
  font-size: 12px;
  color: #475569;
}

.login-main {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 40px 24px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  padding: 36px 34px 28px;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08);
}

.login-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--knet-text);
}

.login-subtitle {
  margin: 8px 0 22px;
  font-size: 13px;
  color: var(--knet-text-secondary);
}

.login-error {
  margin-bottom: 16px;
}

.login-button {
  width: 100%;
  margin-top: 4px;
}

.login-hint {
  margin: 20px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--knet-text-muted);
}

@media (max-width: 960px) {
  .login-brand {
    display: none;
  }
}
</style>

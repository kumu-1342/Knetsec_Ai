/**
 * 登录态 Store。
 *
 * 设计要点：
 * - token 持久化到 localStorage（键名与 axios 拦截器共用常量），刷新页面不掉登录；
 * - 用户信息只放内存，刷新后由路由守卫调用 GET /auth/me 重新校验 token 是否有效，
 *   这样管理员改密/禁用在下次刷新即生效，避免把过期用户信息长期存在本地；
 * - 所有方法不做路由跳转，路由决策集中在 router 守卫与页面，降低耦合。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { AuthUser, ChangePasswordRequest, LoginRequest, LoginResponse } from '@knetsec/shared';
import { authApi } from '@/api';
import { TOKEN_STORAGE_KEY } from '@/api/client';

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string>(localStorage.getItem(TOKEN_STORAGE_KEY) ?? '');
  const user = ref<AuthUser | null>(null);
  const loginLoading = ref(false);
  const meLoading = ref(false);

  /** 是否已加载过用户信息，路由守卫据此决定是否需要请求 /auth/me。 */
  const loaded = computed(() => user.value !== null);
  const isLoggedIn = computed(() => token.value !== '');
  const isAdmin = computed(() => user.value?.role === 'admin');
  const displayName = computed(() => user.value?.displayName || user.value?.username || '未登录');
  const roleLabel = computed(() => (user.value?.role === 'admin' ? '管理员' : '只读用户'));
  const mustChangePassword = computed(() => user.value?.mustChangePassword === true);
  /** 用户名首字母/首字，用于头像占位。 */
  const avatarText = computed(() => displayName.value.slice(0, 1).toUpperCase());

  /** 写入或清除 token，保持内存与 localStorage 同步。 */
  function setToken(nextToken: string): void {
    token.value = nextToken;
    if (nextToken) {
      localStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  }

  /** 清空登录态（不触发跳转，由调用方决定去登录页还是留在原地）。 */
  function clearSession(): void {
    setToken('');
    user.value = null;
  }

  /**
   * 登录并写入 token/用户信息。
   *
   * @param payload 用户名密码
   * @param silent 是否静默（登录页行内展示错误时传 true）
   * @returns 登录响应，页面可据此读取 mustChangePassword
   */
  async function login(payload: LoginRequest, silent = false): Promise<LoginResponse> {
    loginLoading.value = true;
    try {
      const response = await authApi.login(payload, silent);
      setToken(response.token);
      user.value = response.user;
      return response;
    } finally {
      loginLoading.value = false;
    }
  }

  /** 校验 token 并刷新用户信息；401 时由 axios 拦截器负责跳转。 */
  async function fetchMe(): Promise<AuthUser> {
    meLoading.value = true;
    try {
      const me = await authApi.me();
      user.value = me;
      return me;
    } finally {
      meLoading.value = false;
    }
  }

  /** 修改密码；成功后服务端会清 mustChangePassword，本地同步更新避免横幅残留。 */
  async function changePassword(payload: ChangePasswordRequest): Promise<void> {
    await authApi.changePassword(payload);
    if (user.value) {
      user.value = { ...user.value, mustChangePassword: false };
    }
  }

  function logout(): void {
    clearSession();
  }

  return {
    token,
    user,
    loginLoading,
    meLoading,
    loaded,
    isLoggedIn,
    isAdmin,
    displayName,
    roleLabel,
    mustChangePassword,
    avatarText,
    login,
    fetchMe,
    changePassword,
    logout,
    clearSession,
  };
});

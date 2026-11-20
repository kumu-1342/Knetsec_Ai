/**
 * 应用级 UI 状态。
 *
 * 只承载「跨页面但不属于业务」的状态：侧边栏折叠、系统信息（版本/运行时长）。
 * 业务数据一律留在各自页面，避免全局 store 变成隐形数据总线导致刷新逻辑难追踪。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { APP_VERSION } from '@knetsec/shared';
import { systemApi, type SystemInfo } from '@/api';

export const useAppStore = defineStore('app', () => {
  const sidebarCollapsed = ref(false);
  const systemInfo = ref<SystemInfo | null>(null);
  const systemInfoLoading = ref(false);

  /** 版本号：优先取服务端上报，失败时退回构建期常量。 */
  const version = computed(() => systemInfo.value?.version ?? APP_VERSION);
  const running = computed(() => systemInfo.value?.scheduler?.running === true);
  const enabledSources = computed(
    () => systemInfo.value?.scheduler?.enabledSources ?? systemInfo.value?.sources ?? 0,
  );

  /** 服务端运行时长文案（秒 → 天/小时/分钟）。 */
  const uptimeText = computed(() => {
    const seconds = systemInfo.value?.uptimeSeconds ?? systemInfo.value?.uptime;
    if (!seconds || seconds <= 0) return '-';
    if (seconds < 60) return `${seconds} 秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
    return `${Math.floor(seconds / 86400)} 天 ${Math.floor((seconds % 86400) / 3600)} 小时`;
  });

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  /**
   * 加载系统信息。
   *
   * @param force 是否强制刷新（默认已有缓存则跳过，避免每次路由切换都请求）
   */
  async function loadSystemInfo(force = false): Promise<void> {
    if (systemInfoLoading.value) return;
    if (systemInfo.value && !force) return;
    systemInfoLoading.value = true;
    try {
      systemInfo.value = await systemApi.info();
    } catch {
      // 系统信息属于辅助展示，失败静默；不打扰正在操作的用户。
    } finally {
      systemInfoLoading.value = false;
    }
  }

  return {
    sidebarCollapsed,
    systemInfo,
    systemInfoLoading,
    version,
    running,
    enabledSources,
    uptimeText,
    toggleSidebar,
    loadSystemInfo,
  };
});

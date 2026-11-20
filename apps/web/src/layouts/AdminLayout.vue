<script setup lang="ts">
/**
 * 管理面板主布局：深色侧边栏 + 顶栏 + 内容区。
 *
 * 为什么把导航、面包屑、用户菜单集中在这里：
 * 1. 所有业务页面共享同一套导航结构，新增页面只需在 router 注册即可出现在菜单；
 * 2. 管理员与只读用户通过 auth.isAdmin 统一裁剪入口（viewer 看不到审计），
 *    页面内部的写操作按钮再各自按角色隐藏，双重保障；
 * 3. 强制改密横幅放在内容区顶部，登录后无论进入哪个页面都能看到提醒。
 */
import { computed, onMounted, ref, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  ArrowDown,
  Connection,
  Document,
  Expand,
  Fold,
  Lock,
  Notebook,
  Odometer,
  Refresh,
  Setting,
  SwitchButton,
  Tickets,
  Timer,
} from '@element-plus/icons-vue';
import { APP_NAME } from '@knetsec/shared';
import { useAuthStore } from '@/stores/auth';
import { useAppStore } from '@/stores/app';
import ChangePasswordDialog from '@/components/ChangePasswordDialog.vue';

interface MenuItem {
  path: string;
  title: string;
  icon: Component;
  /** 仅管理员可见（viewer 直接不渲染入口） */
  adminOnly?: boolean;
}

interface MenuGroup {
  title: string;
  items: MenuItem[];
}

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const app = useAppStore();

/** 导航分组：与 docs/05 的信息架构表保持一致，避免菜单与文档漂移。 */
const menuGroups: MenuGroup[] = [
  {
    title: '总览',
    items: [
      { path: '/dashboard', title: '仪表盘', icon: Odometer },
      { path: '/items', title: '情报中心', icon: Document },
    ],
  },
  {
    title: '情报运营',
    items: [
      { path: '/sources', title: '数据源管理', icon: Connection },
      { path: '/tasks', title: '采集任务', icon: Timer },
      { path: '/reports', title: '报告中心', icon: Notebook },
    ],
  },
  {
    title: '系统',
    items: [
      { path: '/settings', title: '系统设置', icon: Setting },
      { path: '/audit', title: '审计日志', icon: Tickets, adminOnly: true },
    ],
  },
];

const visibleGroups = computed<MenuGroup[]>(() =>
  menuGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.adminOnly || auth.isAdmin),
    }))
    .filter((group) => group.items.length > 0),
);

const asideWidth = computed(() => (app.sidebarCollapsed ? '64px' : '232px'));

/** 报告详情页也要高亮「报告中心」菜单。 */
const activeMenu = computed(() => (route.path.startsWith('/reports') ? '/reports' : route.path));

const changePasswordVisible = ref(false);

/** 刷新当前页面数据的轻量实现：变更 router-view key 触发组件重建与重新拉取。 */
const viewKey = ref(0);
function refreshPage(): void {
  viewKey.value += 1;
}

onMounted(() => {
  void app.loadSystemInfo();
});

async function handleLogout(): Promise<void> {
  try {
    await ElMessageBox.confirm('退出后需要重新登录才能访问管理面板。', '退出登录', {
      confirmButtonText: '退出登录',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }
  auth.logout();
  ElMessage.success('已退出登录');
  await router.push('/login');
}

function handlePasswordChanged(): void {
  // 改密后旧 token 仍可能有效，但为安全起见统一要求重新登录。
  auth.logout();
  void router.push('/login');
}

function handleUserCommand(command: string | number | object): void {
  if (command === 'password') {
    changePasswordVisible.value = true;
    return;
  }
  if (command === 'logout') {
    void handleLogout();
  }
}
</script>

<template>
  <el-container class="admin-shell">
    <el-aside :width="asideWidth" class="knet-sidebar">
      <div class="brand" :class="{ 'is-collapsed': app.sidebarCollapsed }">
        <div class="brand-logo">K</div>
        <div v-show="!app.sidebarCollapsed" class="brand-text">
          <div class="brand-name">{{ APP_NAME }}</div>
          <div class="brand-sub">AI 安全 × 网络安全</div>
        </div>
      </div>

      <el-scrollbar class="sidebar-scroll">
        <el-menu
          :default-active="activeMenu"
          :collapse="app.sidebarCollapsed"
          :collapse-transition="false"
          router
          class="sidebar-menu"
        >
          <template v-for="group in visibleGroups" :key="group.title">
            <div v-if="!app.sidebarCollapsed" class="menu-group-title">{{ group.title }}</div>
            <el-menu-item v-for="item in group.items" :key="item.path" :index="item.path">
              <el-icon><component :is="item.icon" /></el-icon>
              <template #title>{{ item.title }}</template>
            </el-menu-item>
          </template>
        </el-menu>
      </el-scrollbar>

      <div v-show="!app.sidebarCollapsed" class="sidebar-footer">
        <div class="footer-row">
          <span>版本</span>
          <span>v{{ app.version }}</span>
        </div>
        <div class="footer-row">
          <span>运行时长</span>
          <span>{{ app.uptimeText }}</span>
        </div>
        <div class="footer-status">
          <span class="status-dot" :class="{ 'is-running': app.running }" />
          <span>{{ app.running ? '采集任务运行中' : `调度器空闲 · ${app.enabledSources} 源启用` }}</span>
        </div>
      </div>
    </el-aside>

    <el-container class="main-wrap">
      <el-header class="knet-header" height="60px">
        <div class="header-left">
          <el-button text circle class="collapse-btn" title="折叠/展开侧边栏" @click="app.toggleSidebar()">
            <el-icon :size="18">
              <Expand v-if="app.sidebarCollapsed" />
              <Fold v-else />
            </el-icon>
          </el-button>
          <el-breadcrumb separator="/" class="header-breadcrumb">
            <el-breadcrumb-item :to="{ path: '/dashboard' }">首页</el-breadcrumb-item>
            <el-breadcrumb-item v-if="route.meta.group">{{ route.meta.group }}</el-breadcrumb-item>
            <el-breadcrumb-item>{{ route.meta.title }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>

        <div class="header-right">
          <el-tooltip content="刷新当前页面" placement="bottom">
            <el-button text circle @click="refreshPage">
              <el-icon :size="17"><Refresh /></el-icon>
            </el-button>
          </el-tooltip>

          <el-dropdown trigger="click" @command="handleUserCommand">
            <div class="user-trigger">
              <el-avatar :size="30" class="user-avatar">{{ auth.avatarText }}</el-avatar>
              <span class="user-name">{{ auth.displayName }}</span>
              <el-tag size="small" effect="plain" :type="auth.isAdmin ? 'primary' : 'info'">
                {{ auth.roleLabel }}
              </el-tag>
              <el-icon class="user-arrow"><ArrowDown /></el-icon>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="password" :icon="Lock">修改密码</el-dropdown-item>
                <el-dropdown-item command="logout" divided :icon="SwitchButton">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="knet-main">
        <el-alert
          v-if="auth.mustChangePassword"
          type="warning"
          :closable="false"
          show-icon
          class="must-change-alert"
        >
          <template #title>
            <div class="must-change-content">
              <span>当前账号仍在使用初始密码，存在安全风险，请尽快修改。</span>
              <el-button size="small" type="warning" plain @click="changePasswordVisible = true">
                立即修改
              </el-button>
            </div>
          </template>
        </el-alert>

        <router-view v-slot="{ Component: RouteComponent }">
          <transition name="fade" mode="out-in">
            <component :is="RouteComponent" :key="`${route.fullPath}-${viewKey}`" />
          </transition>
        </router-view>
      </el-main>
    </el-container>

    <ChangePasswordDialog v-model="changePasswordVisible" @success="handlePasswordChanged" />
  </el-container>
</template>

<style scoped>
.admin-shell {
  height: 100vh;
  overflow: hidden;
}

/* 侧边栏：固定深色底，内部滚动区承载菜单，底部展示版本与调度状态。 */
.knet-sidebar {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--knet-sidebar);
  transition: width 0.2s ease;
  overflow: hidden;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 64px;
  padding: 0 16px;
  flex-shrink: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.brand.is-collapsed {
  justify-content: center;
  padding: 0;
}

.brand-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  font-size: 17px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #2563eb, #7c3aed);
  border-radius: 9px;
}

.brand-text {
  min-width: 0;
}

.brand-name {
  font-size: 15px;
  font-weight: 600;
  color: #f8fafc;
  letter-spacing: 0.2px;
  white-space: nowrap;
}

.brand-sub {
  margin-top: 1px;
  font-size: 11px;
  color: #94a3b8;
  white-space: nowrap;
}

.sidebar-scroll {
  flex: 1;
  padding: 10px 0;
}

.menu-group-title {
  padding: 14px 22px 6px;
  font-size: 11px;
  letter-spacing: 1px;
  color: #64748b;
}

.sidebar-menu {
  --el-menu-bg-color: transparent;
  --el-menu-text-color: #cbd5e1;
  --el-menu-hover-bg-color: var(--knet-sidebar-hover);
  --el-menu-active-color: #ffffff;
  border-right: none;
}

.sidebar-menu :deep(.el-menu-item) {
  height: 42px;
  margin: 2px 10px;
  font-size: 14px;
  border-radius: 8px;
}

.sidebar-menu :deep(.el-menu-item.is-active) {
  background: var(--knet-sidebar-active);
  color: #fff;
  font-weight: 500;
}

.sidebar-menu :deep(.el-menu-item:hover) {
  background: var(--knet-sidebar-hover);
}

.sidebar-footer {
  flex-shrink: 0;
  padding: 12px 18px 16px;
  font-size: 12px;
  color: #94a3b8;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.footer-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
}

.footer-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  color: #64748b;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #64748b;
  flex-shrink: 0;
}

.status-dot.is-running {
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.18);
}

.main-wrap {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-width: 0;
  background: var(--knet-bg);
}

.knet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  padding: 0 20px 0 10px;
  background: #fff;
  border-bottom: 1px solid #eef1f6;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.collapse-btn {
  color: #64748b;
}

.header-breadcrumb {
  font-size: 13px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.user-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 8px;
  cursor: pointer;
  outline: none;
}

.user-trigger:hover {
  background: #f1f5f9;
}

.user-avatar {
  background: linear-gradient(135deg, #2563eb, #7c3aed);
  color: #fff;
  font-size: 13px;
}

.user-name {
  max-width: 120px;
  overflow: hidden;
  font-size: 14px;
  color: var(--knet-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-arrow {
  color: #94a3b8;
  font-size: 12px;
}

.knet-main {
  flex: 1;
  padding: 0;
  overflow-y: auto;
}

.must-change-alert {
  margin: 16px 20px 0;
}

.must-change-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
</style>

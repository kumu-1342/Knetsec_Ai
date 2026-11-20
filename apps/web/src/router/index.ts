/**
 * 路由表与全局守卫。
 *
 * 为什么把面包屑信息放进 route.meta：路由是唯一同时知道「当前页面属于哪个分组」的地方，
 * 页面组件不必自己维护标题，布局层直接读 meta 即可生成面包屑与菜单高亮。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { ElMessage } from 'element-plus';
import { APP_NAME } from '@knetsec/shared';
import { useAuthStore } from '@/stores/auth';

declare module 'vue-router' {
  interface RouteMeta {
    /** 页面标题（同时用于面包屑与浏览器标题） */
    title?: string;
    /** 所属导航分组（面包屑上级） */
    group?: string;
    /** 公开页面，不需要登录 */
    public?: boolean;
    /** 仅管理员可访问 */
    requiresAdmin?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { title: '登录', public: true },
  },
  {
    path: '/',
    component: () => import('@/layouts/AdminLayout.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('@/views/DashboardView.vue'),
        meta: { title: '仪表盘', group: '总览' },
      },
      {
        path: 'items',
        name: 'items',
        component: () => import('@/views/ItemsView.vue'),
        meta: { title: '情报中心', group: '情报运营' },
      },
      {
        path: 'sources',
        name: 'sources',
        component: () => import('@/views/SourcesView.vue'),
        meta: { title: '数据源管理', group: '情报运营' },
      },
      {
        path: 'tasks',
        name: 'tasks',
        component: () => import('@/views/TasksView.vue'),
        meta: { title: '采集任务', group: '情报运营' },
      },
      {
        path: 'reports',
        name: 'reports',
        component: () => import('@/views/ReportsView.vue'),
        meta: { title: '报告中心', group: '情报运营' },
      },
      {
        path: 'reports/:id',
        name: 'report-detail',
        component: () => import('@/views/ReportDetailView.vue'),
        meta: { title: '报告预览', group: '情报运营' },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/views/SettingsView.vue'),
        meta: { title: '系统设置', group: '系统' },
      },
      {
        path: 'audit',
        name: 'audit',
        component: () => import('@/views/AuditView.vue'),
        meta: { title: '审计日志', group: '系统', requiresAdmin: true },
      },
      {
        path: ':pathMatch(.*)*',
        name: 'not-found',
        component: () => import('@/views/NotFound.vue'),
        meta: { title: '页面不存在' },
      },
    ],
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach(async (to) => {
  document.title = to.meta.title ? `${to.meta.title} · ${APP_NAME} 管理面板` : `${APP_NAME} 管理面板`;

  const auth = useAuthStore();

  if (to.meta.public) {
    // 已登录用户访问登录页直接回仪表盘，避免重复登录。
    return auth.isLoggedIn ? { path: '/dashboard' } : true;
  }

  if (!auth.isLoggedIn) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }

  if (!auth.loaded) {
    try {
      await auth.fetchMe();
    } catch {
      auth.clearSession();
      return { path: '/login', query: { redirect: to.fullPath } };
    }
  }

  if (to.meta.requiresAdmin && !auth.isAdmin) {
    ElMessage.warning('该页面仅管理员可访问');
    return { path: '/dashboard' };
  }

  return true;
});

export default router;

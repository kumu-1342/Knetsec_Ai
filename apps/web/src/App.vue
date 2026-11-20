<script setup lang="ts">
/**
 * 根组件。
 *
 * 这里刻意不渲染侧边栏/页头：登录页需要全屏独立布局，而业务页面统一由
 * AdminLayout 提供外壳。根组件只保留一个路由出口，避免登录页套壳。
 */
import { RouterView } from 'vue-router';
</script>

<template>
  <RouterView />
</template>

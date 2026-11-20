<script setup lang="ts">
/**
 * 404 页面：保持应用外壳内的导航能力，避免用户被“死路”卡住。
 */
import { useRouter } from 'vue-router';
import { ArrowLeft, HomeFilled } from '@element-plus/icons-vue';

const router = useRouter();

function goBack(): void {
  router.back();
}
</script>

<template>
  <div class="page-container">
    <div class="knet-card not-found-card">
      <el-result
        icon="warning"
        title="404 · 页面不存在"
        sub-title="你访问的地址可能已被移动或删除，请从左侧菜单重新进入。"
      >
        <template #extra>
          <el-button :icon="ArrowLeft" @click="goBack">返回上一页</el-button>
          <el-button type="primary" :icon="HomeFilled" @click="router.push('/dashboard')">
            回到仪表盘
          </el-button>
        </template>
      </el-result>
    </div>
  </div>
</template>

<style scoped>
.not-found-card {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 480px;
}
</style>

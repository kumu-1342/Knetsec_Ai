<script setup lang="ts">
/**
 * 严重度标签。
 *
 * 统一「中文文案 + 颜色」映射，避免列表、详情、报告各处出现 critical/严重混用。
 */
import { computed } from 'vue';
import { SEVERITY_LABELS, type Severity } from '@knetsec/shared';
import { SEVERITY_TAG_TYPES } from '@/utils/enums';

interface Props {
  severity: Severity;
  size?: 'small' | 'default' | 'large';
  effect?: 'light' | 'dark' | 'plain';
}

const props = withDefaults(defineProps<Props>(), { size: 'small', effect: 'light' });
const label = computed(() => SEVERITY_LABELS[props.severity] ?? '未知');
</script>

<template>
  <el-tag
    :type="SEVERITY_TAG_TYPES[props.severity]"
    :size="props.size"
    :effect="props.effect"
    disable-transitions
  >
    {{ label }}
  </el-tag>
</template>

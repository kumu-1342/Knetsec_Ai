/**
 * 流水线统一出口。
 *
 * 为什么需要：编排器（pipeline/orchestrator.ts）与测试只从这一个模块导入归一化/去重能力，
 * 这样内部实现文件可以自由拆分（normalize/dedupe/enrich），调用方不需要跟着改 import 路径。
 * 契约见 docs/00 §7.3。
 */
export * from './normalize.js';
export * from './dedupe.js';
export type { NormalizedItem, DedupeResult, CrossSourceDuplicate } from '@knetsec/shared';

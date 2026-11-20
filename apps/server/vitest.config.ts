/**
 * 服务端测试配置。
 *
 * - 只跑 tests 目录下的 *.test.ts（LIVE 实测文件用 describe.skipIf(!process.env.LIVE) 自我门控，
 *   默认全部跳过，不会访问外网，因此不在这里 exclude）；
 * - node 环境（node:sqlite 需要真实 Node 运行时，不能用 jsdom）；
 * - 放宽超时：scrypt 哈希在低配机器上约 50-100ms，集成测试含多次建库/登录；
 * - 串行执行测试文件：每个文件都会打开 SQLite（含 WAL 文件句柄），并发易触发文件句柄竞争。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});

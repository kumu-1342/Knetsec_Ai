/**
 * 服务进程入口：建目录 → 建库 → 迁移/种子（buildApp 内）→ 监听 → 优雅关闭。
 *
 * 优雅关闭的意义：SQLite 需要正常 close 才能合并 WAL；调度器需要 stop 才能取消定时器，
 * 否则 Windows 上进程会残留或 data 目录出现 -wal/-shm 文件。
 */
import { API_PREFIX } from '@knetsec/shared';
import { buildApp } from './app.js';
import { config, ensureRuntimeDirs } from './config.js';
import { createLogger } from './infra/logger.js';

/** 主流程：启动服务并挂载信号处理。 */
async function main(): Promise<void> {
  ensureRuntimeDirs();
  const logger = createLogger('knetsec.server');
  const app = await buildApp({ logger });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '收到退出信号，开始优雅关闭');
    try {
      await app.close();
      logger.info({}, '服务已安全关闭');
    } catch (error) {
      logger.error({ err: String(error) }, '关闭服务时出错');
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: String(reason) }, '未处理的 Promise 拒绝');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, '未捕获异常，进程退出');
    process.exit(1);
  });

  await app.listen({ host: config.host, port: config.port });

  const baseUrl = `http://${config.host}:${config.port}`;
  logger.info(
    {
      url: baseUrl,
      api: `${baseUrl}${API_PREFIX}`,
      docs: `${baseUrl}/docs`,
      health: `${baseUrl}/health`,
      scheduler: config.schedulerEnabled,
    },
    `${config.appName} 服务已启动`,
  );
  // 面向人的启动提示（浏览器/终端直接可见）
  console.log(
    [
      '',
      `  ${config.appName} 已启动`,
      `  管理面板：${baseUrl}`,
      `  API 前缀：${baseUrl}${API_PREFIX}`,
      `  接口文档：${baseUrl}/docs`,
      `  健康检查：${baseUrl}/health`,
      '',
    ].join('\n'),
  );
}

void main().catch((error: unknown) => {
  console.error('服务启动失败：', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

/**
 * 结构化日志（pino）。
 *
 * - 生产环境输出 JSON，便于采集到 ELK/Loki；
 * - 开发环境使用 pino-pretty 彩色输出（仅开发依赖，生产镜像不安装）；
 * - 所有日志带 app / version 字段，方便多实例区分。
 */
import pino from 'pino';
import { APP_VERSION } from '@knetsec/shared';
import { config } from '../config.js';

export type AppLogger = pino.Logger;

/** 创建带组件名的子日志器，例如 createLogger('collector.github')。 */
export function createLogger(name = 'knetsec'): AppLogger {
  const options: pino.LoggerOptions = {
    name,
    level: process.env.LOG_LEVEL ?? (config.isProduction ? 'info' : 'debug'),
    base: { app: config.appName, version: APP_VERSION },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      // 避免把密钥写进日志
      paths: ['password', '*.password', 'llmApiKey', '*.llmApiKey', 'token', '*.token', 'authorization'],
      censor: '[REDACTED]',
    },
  };

  if (!config.isProduction) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,app,version' },
    };
  }

  return pino(options);
}

/** 全局根日志器。 */
export const logger = createLogger();

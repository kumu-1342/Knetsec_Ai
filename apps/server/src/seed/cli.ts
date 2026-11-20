/**
 * 种子数据命令行入口：`npm run seed`。
 *
 * 独立于服务进程，方便部署后在无 UI 的情况下重建默认管理员/数据源；
 * 全程幂等，可重复执行。
 */
import { ensureRuntimeDirs, config } from '../config.js';
import { openDatabase } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { migrate } from '../infra/migrations.js';
import { ensureSeedData } from './index.js';

async function main(): Promise<void> {
  ensureRuntimeDirs();
  const logger = createLogger('knetsec-seed');
  const db = openDatabase(config.dbPath);
  try {
    const migrations = migrate(db, logger);
    logger.info({ applied: migrations }, '数据库迁移完成');
    const result = await ensureSeedData(db, logger);
    logger.info(result, '种子数据初始化完成');
    // CLI 面向人，额外输出一行中文摘要
    console.log(
      `[seed] 数据库：${config.dbPath}\n[seed] 管理员：${result.adminCreated ? '已创建' : '已存在，跳过'}\n[seed] 默认数据源：新增 ${result.sourcesInserted} 个（共 ${result.settingsKeys} 项设置已就绪）`,
    );
  } finally {
    db.close();
  }
}

void main().catch((error: unknown) => {
  console.error('[seed] 种子数据初始化失败：', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

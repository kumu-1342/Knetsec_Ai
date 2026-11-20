/**
 * 服务端配置装载。
 *
 * 设计原则：
 * 1. 所有可变配置优先读环境变量（支持 .env 文件），缺省值保证「开箱即跑」；
 * 2. 运行时数据（SQLite、报告、日志、JWT 密钥）统一落在 <仓库根>/data，便于备份与迁移；
 * 3. 默认只监听 127.0.0.1，避免把情报管理面板暴露到公网。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** 从当前文件向上查找仓库根目录（以 package.json name=knetsec-ai 为锚点）。 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'knetsec-ai') return dir;
      } catch {
        // 忽略损坏的 package.json，继续向上查找
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot(currentDir);

/** 加载仓库根目录的 .env（Node 20.12+ 原生支持，无需 dotenv 依赖）。 */
function loadDotEnv(): void {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    console.warn('[config] 加载 .env 失败，将仅使用系统环境变量:', error);
  }
}
loadDotEnv();

function envString(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export const DATA_DIR = process.env.KNETSEC_DATA_DIR
  ? path.resolve(REPO_ROOT, process.env.KNETSEC_DATA_DIR)
  : path.join(REPO_ROOT, 'data');

const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

/** 首次启动时自动创建运行期目录。 */
export function ensureRuntimeDirs(): void {
  for (const dir of [DATA_DIR, REPORTS_DIR, LOGS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 读取 JWT 签名密钥：环境变量 > data/.jwt-secret > 自动生成并持久化。
 * 自动生成保证首次启动无需手工配置，同时重启后已签发的 token 仍然有效。
 */
function loadJwtSecret(): string {
  const fromEnv = process.env.KNETSEC_JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  const secretFile = path.join(DATA_DIR, '.jwt-secret');
  if (fs.existsSync(secretFile)) {
    const saved = fs.readFileSync(secretFile, 'utf8').trim();
    if (saved.length >= 16) return saved;
  }

  const generated = crypto.randomBytes(48).toString('hex');
  ensureRuntimeDirs();
  fs.writeFileSync(secretFile, generated, { encoding: 'utf8', mode: 0o600 });
  return generated;
}

const isProduction = envString('NODE_ENV', 'development') === 'production';

/** 全局配置单例（冻结，防止运行期被误改）。 */
export const config = Object.freeze({
  appName: 'Knetsec_Ai',
  version: '1.0.0',
  env: isProduction ? 'production' : 'development',
  isProduction,
  host: envString('KNETSEC_HOST', '127.0.0.1'),
  port: envNumber('KNETSEC_PORT', 8787),
  /** 服务端对外基础路径，与 shared 包 API_PREFIX 保持一致 */
  apiPrefix: '/api/v1',
  repoRoot: REPO_ROOT,
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'knetsec.db'),
  reportsDir: REPORTS_DIR,
  logsDir: LOGS_DIR,
  webDistDir: path.join(REPO_ROOT, 'apps', 'web', 'dist'),
  jwt: {
    secret: loadJwtSecret(),
    /** 12 小时，兼顾安全与使用便利 */
    expiresInSeconds: envNumber('KNETSEC_JWT_TTL', 12 * 3600),
  },
  admin: {
    username: envString('ADMIN_USERNAME', 'admin'),
    password: envString('ADMIN_PASSWORD', 'admin123'),
  },
  schedulerEnabled: envString('KNETSEC_SCHEDULER', 'on') !== 'off',
  secrets: {
    githubToken: envString('GITHUB_TOKEN'),
    nvdApiKey: envString('NVD_API_KEY'),
  },
  /** 大陆网络访问部分数据源（如 CNVD）失败时可配置代理 */
  httpProxy: envString('KNETSEC_HTTP_PROXY') || envString('HTTPS_PROXY'),
  corsOrigins: envString('KNETSEC_CORS_ORIGINS', 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
});

export type AppConfig = typeof config;

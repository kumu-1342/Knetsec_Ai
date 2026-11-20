/**
 * 密码与密钥安全工具。
 *
 * - 密码哈希使用 Node 内置 scrypt（N=16384, r=8, p=1, 64 字节输出），不引入 bcrypt 原生依赖；
 * - 比对使用 timingSafeEqual 防止时序攻击；
 * - 脱敏函数用于 API 返回 LLM Key / Webhook 等敏感字段。
 */
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
  type ScryptOptions,
} from 'node:crypto';

/**
 * Promise 化 scrypt。
 * 注意：Node 的 scrypt 有多个重载，util.promisify 会丢失带 options 的重载，
 * 因此这里手写 Promise 包装，保证 N/r/p/maxmem 参数生效。
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 64 } as const;
const SCRYPT_PREFIX = 'scrypt';

/** 生成密码哈希，格式：scrypt$N=16384,r=8,p=1$<saltBase64>$<hashBase64> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  });

  return [
    SCRYPT_PREFIX,
    `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** 校验明文密码与哈希是否匹配（任何格式异常都视为不匹配，不抛错）。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [prefix, , saltB64, hashB64] = stored.split('$');
    if (prefix !== SCRYPT_PREFIX || !saltB64 || !hashB64) return false;

    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scryptAsync(password, salt, expected.length, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: 64 * 1024 * 1024,
    });

    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 密码强度校验：至少 8 位，且同时包含字母与数字。返回 null 表示通过。 */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return '密码长度至少 8 位';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return '密码需同时包含字母和数字';
  return null;
}

/** 敏感信息脱敏：仅保留前后各 4 位。 */
export function maskSecret(secret: string | null | undefined): string {
  if (!secret) return '';
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

/** 计算 SHA-256 十六进制摘要（用于情报去重 uid 等）。 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
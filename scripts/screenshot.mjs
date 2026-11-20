#!/usr/bin/env node
/**
 * 管理面板自动截图脚本（用于验收证据与文档配图）。
 *
 * 依赖：playwright-core（只驱动本机已安装的 Chrome/Edge，不下载浏览器内核）。
 * 前置：服务端已启动（http://127.0.0.1:8787），管理员账号可用。
 * 用法：node scripts/screenshot.mjs
 * 产物：docs/assets/{login,dashboard,items,sources,tasks,reports,settings}.png
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const BASE = process.env.KNETSEC_BASE_URL ?? `http://127.0.0.1:${process.env.KNETSEC_PORT ?? '8787'}`;
const USERNAME = process.env.ADMIN_USERNAME ?? 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123';
const OUT_DIR = path.resolve('docs', 'assets');
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('未找到 Chrome/Edge，无法截图');

  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  const shot = async (name, options = {}) => {
    const file = path.join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: file, ...options });
    console.log('saved', path.relative(process.cwd(), file));
  };

  // 1. 登录页
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot('login');

  // 2. 登录
  await page.getByPlaceholder(/用户名/).first().fill(USERNAME);
  await page.getByPlaceholder(/密码/).first().fill(PASSWORD);
  await page.getByRole('button', { name: /登\s*录/ }).first().click();
  await page.waitForURL(/dashboard/, { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await shot('dashboard', { fullPage: true });

  // 3. 情报中心
  await page.goto(`${BASE}/items`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await shot('items', { fullPage: false });

  // 4. 数据源
  await page.goto(`${BASE}/sources`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot('sources');

  // 5. 采集任务
  await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot('tasks');

  // 6. 报告中心
  await page.goto(`${BASE}/reports`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot('reports');

  // 7. 系统设置
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot('settings', { fullPage: true });

  // 8. 报告预览（进入最新报告）
  await page.goto(`${BASE}/reports`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const preview = page.getByRole('button', { name: /预览/ }).first();
  if (await preview.count()) {
    await preview.click();
    await page.waitForTimeout(2000);
    await shot('report-preview', { fullPage: true });
  }

  if (consoleErrors.length > 0) {
    console.log('\n页面控制台错误：');
    for (const error of consoleErrors.slice(0, 10)) console.log('-', error);
  } else {
    console.log('\n页面控制台无错误');
  }

  await browser.close();
}

main().catch((error) => {
  console.error('截图失败：', error);
  process.exit(1);
});

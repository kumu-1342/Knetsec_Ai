#!/usr/bin/env node
/**
 * Knetsec_Ai 开发环境启动器。
 *
 * 作用：一条命令同时拉起
 *   1) Fastify 服务端（tsx watch，端口 8787）
 *   2) Vite 前端开发服务器（端口 5173，/api 自动代理到 8787）
 * 并统一转发日志、在任一进程退出时优雅关闭另一个进程（Windows 下用 taskkill 结束进程树）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

/** 子进程列表，用于退出时统一清理 */
const children = [];

function start(name, args, color) {
  const child = spawn(npm, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  children.push({ name, child });
  child.on('exit', (code) => {
    console.log(`[${color}${name}${color === '' ? '' : ''}[0m] 进程退出，code=${code}`);
    shutdown(code ?? 0);
  });
  console.log(`[dev] 已启动 ${name} (pid=${child.pid})`);
}

function shutdown(code) {
  for (const { child } of children) {
    if (child.exitCode !== null) continue;
    if (isWindows) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('==============================================');
console.log(' Knetsec_Ai 开发环境');
console.log(' 服务端 API : http://127.0.0.1:8787');
console.log(' 管理面板   : http://127.0.0.1:5173');
console.log(' 接口文档   : http://127.0.0.1:8787/docs');
console.log('==============================================');

start('server', ['-w', '@knetsec/server', 'run', 'dev'], 'server');
start('web', ['-w', '@knetsec/web', 'run', 'dev'], 'web');

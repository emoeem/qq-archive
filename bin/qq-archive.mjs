#!/usr/bin/env node
/**
 * `qq-archive` 命令入口。
 *
 * 为什么需要这个包装脚本：CLI 本体是 TypeScript，靠 Node 的类型剥离直接运行。
 * Node ≥ 23.6 默认开启类型剥离，但本项目最低支持 22.5（那时必须显式带
 * `--experimental-strip-types`），所以这里**显式带上 flag** 再启动，两种版本都能跑。
 *
 * 安装方式（任选其一）：
 *   pnpm link --global      # 或 npm link
 *   或直接写别名：alias qq-archive='node /绝对路径/QQ/bin/qq-archive.mjs'
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'apps', 'cli', 'src', 'main.ts');

const child = spawn(process.execPath, ['--experimental-strip-types', entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

// Ctrl+C / systemd 停止时把信号透传给真正的进程，保证优雅关闭（flush 日志、关数据库）。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

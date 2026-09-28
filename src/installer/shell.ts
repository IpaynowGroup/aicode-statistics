import { fileURLToPath } from 'node:url';

/** POSIX shell 单引号转义 */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 编译后位于 dist/installer/shell.js，CLI 入口为 dist/cli.js */
export function cliPath(): string {
  return fileURLToPath(new URL('../cli.js', import.meta.url));
}

/** 使用 node 与 CLI 的绝对路径，避免钩子运行时 PATH 中找不到 node（如 nvm） */
export function aicodeCommand(args: string): string {
  return `${shq(process.execPath)} ${shq(cliPath())} ${args}`;
}

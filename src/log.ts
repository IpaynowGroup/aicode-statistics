import fs from 'node:fs';
import path from 'node:path';
import { logPath } from './paths.js';

/** 记录错误到本地日志；日志本身失败时静默，绝不抛出 */
export function logError(context: string, err: unknown): void {
  try {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), `${new Date().toISOString()} [${context}] ${detail}\n`);
  } catch {
    // 忽略
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { ledgerDir } from './paths.js';

/** p=仓库相对路径 f=指纹 t=工具 m=模型 s=会话 ts=秒级时间戳 c=消费该记录的 commit sha（amend 前可被同一次 amend 重新借用，见 analyzer.ts） */
export interface LedgerRecord { p: string; f: string; t: string; m: string; s: string; ts: number; c?: string }

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const APPEND_LOCK_WAIT_MS = 1_000; // 钩子路径受 2 秒预算约束

export function ledgerFile(repoKey: string): string {
  return path.join(ledgerDir(), `${repoKey}.jsonl`);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLock<T>(repoKey: string, fn: () => T, waitMs: number = LOCK_WAIT_MS): T {
  const lock = ledgerFile(repoKey) + '.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // 锁刚被释放
      }
      if (Date.now() > deadline) throw new Error(`获取 ledger 锁超时: ${lock}`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // 忽略
    }
  }
}

export function readRecords(repoKey: string): LedgerRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(ledgerFile(repoKey), 'utf8');
  } catch {
    return [];
  }
  const out: LedgerRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as LedgerRecord);
    } catch {
      // 跳过损坏行
    }
  }
  return out;
}

/** 写临时文件后 rename，保证原子替换；调用方须持有锁 */
export function writeRecords(repoKey: string, records: LedgerRecord[]): void {
  const file = ledgerFile(repoKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r) + '\n').join(''));
  fs.renameSync(tmp, file);
}

export function appendRecords(repoKey: string, records: LedgerRecord[]): void {
  if (records.length === 0) return;
  withLock(repoKey, () => {
    fs.appendFileSync(ledgerFile(repoKey), records.map((r) => JSON.stringify(r) + '\n').join(''));
  }, APPEND_LOCK_WAIT_MS);
}

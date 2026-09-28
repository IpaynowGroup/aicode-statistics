import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { appendRecords, ledgerFile, readRecords, withLock, writeRecords, type LedgerRecord } from '../src/ledger.js';
import { tmpHome } from './helpers.js';

const rec = (f: string): LedgerRecord => ({ p: 'a.ts', f, t: 'claude-code', m: 'm', s: 's', ts: 1 });

describe('ledger', () => {
  beforeEach(() => tmpHome());

  it('追加后可读回，文件不存在时为空', () => {
    expect(readRecords('k')).toEqual([]);
    appendRecords('k', [rec('a'), rec('b')]);
    appendRecords('k', [rec('c')]);
    expect(readRecords('k').map((r) => r.f)).toEqual(['a', 'b', 'c']);
  });

  it('writeRecords 整体替换，并跳过损坏的行', () => {
    appendRecords('k', [rec('a')]);
    fs.appendFileSync(ledgerFile('k'), '{broken\n');
    expect(readRecords('k').map((r) => r.f)).toEqual(['a']);
    writeRecords('k', [rec('z')]);
    expect(readRecords('k').map((r) => r.f)).toEqual(['z']);
  });

  it('withLock 执行完释放锁，并能接管超过 10 秒的陈旧锁', () => {
    expect(withLock('k', () => 42)).toBe(42);
    expect(fs.existsSync(ledgerFile('k') + '.lock')).toBe(false);
    fs.mkdirSync(path.dirname(ledgerFile('k')), { recursive: true });
    fs.writeFileSync(ledgerFile('k') + '.lock', '999');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(ledgerFile('k') + '.lock', old, old);
    expect(withLock('k', () => 'ok')).toBe('ok');
  });
});

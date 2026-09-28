import { describe, expect, it } from 'vitest';
import { analyzeCommit } from '../src/analyzer.js';
import { fingerprint } from '../src/fingerprint.js';
import type { FileDiff } from '../src/git.js';
import { buildIgnore } from '../src/ignore.js';
import type { LedgerRecord } from '../src/ledger.js';

const rec = (p: string, line: string, t = 'claude-code', m = 'opus'): LedgerRecord => ({ p, f: fingerprint(line)!, t, m, s: 's', ts: 1 });
const diff = (path: string, added: string[], extra: Partial<FileDiff> = {}): FileDiff => ({ path, oldPath: null, added, deleted: 0, binary: false, ...extra });
const ignored = buildIgnore(null, []);
const mod = () => 'core';

describe('analyzeCommit', () => {
  it('匹配 AI 行、统计人工行，并按工具/模型拆分', () => {
    const records = [rec('a.ts', 'ai one'), rec('a.ts', 'ai two', 'codex', 'gpt'), rec('other.ts', 'z')];
    const r = analyzeCommit([diff('a.ts', ['ai one', 'ai two', 'human', '', '}'], { deleted: 3 })], records, ignored, mod);
    expect(r.stats).toEqual({
      added_total: 3, added_ai: 2, added_human: 1, deleted_total: 3, ai_ratio: 0.667,
      ai_generated: 2, ai_accept_rate: 1,
      by_tool: { 'claude-code/opus': { ai: 1, generated: 1 }, 'codex/gpt': { ai: 1, generated: 1 } },
    });
    expect(r.files).toEqual([{ path: 'a.ts', module: 'core', added: 3, ai: 2 }]);
    expect(r.remaining).toEqual([records[2]]);
  });

  it('每条指纹只能消费一次', () => {
    const r = analyzeCommit([diff('a.ts', ['dup', 'dup', 'dup'])], [rec('a.ts', 'dup'), rec('a.ts', 'dup')], ignored, mod);
    expect(r.stats.added_ai).toBe(2);
    expect(r.stats.added_human).toBe(1);
  });

  it('重命名的文件也能用旧路径下的指纹匹配', () => {
    const r = analyzeCommit([diff('new.ts', ['x'], { oldPath: 'old.ts' })], [rec('old.ts', 'x')], ignored, mod);
    expect(r.stats.added_ai).toBe(1);
  });

  it('忽略被忽略的文件和二进制文件，未生成 AI 行时比率为 0', () => {
    const r = analyzeCommit(
      [diff('package-lock.json', ['a'], { deleted: 5 }), diff('img.png', [], { binary: true })],
      [rec('package-lock.json', 'a')], ignored, mod,
    );
    expect(r.stats).toMatchObject({ added_total: 0, deleted_total: 0, ai_ratio: 0, ai_generated: 0, ai_accept_rate: 0 });
    expect(r.files).toEqual([]);
  });

  it('生成量包含本次涉及文件中未被提交的 AI 行', () => {
    const r = analyzeCommit([diff('a.ts', ['kept'])], [rec('a.ts', 'kept'), rec('a.ts', 'dropped')], ignored, mod);
    expect(r.stats).toMatchObject({ added_ai: 1, ai_generated: 2, ai_accept_rate: 0.5 });
  });
});

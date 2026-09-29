import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fingerprintText } from '../src/fingerprint.js';
import { buildIgnore } from '../src/ignore.js';
import { pendingDir } from '../src/paths.js';
import {
  BudgetExceeded, captureEditBaseline, captureShellBaseline, cleanupPending, editChanges, MAX_FILE_BYTES,
  hasPending, isDone, readFingerprints, savePending, shellChanges, takePending,
} from '../src/snapshot.js';
import { commitAll, initRepo, tmpHome } from './helpers.js';

const far = () => Date.now() + 60_000;

describe('readFingerprints', () => {
  beforeEach(() => tmpHome());
  it('不存在返回 []，二进制和超大文件返回 null', () => {
    const repo = initRepo();
    expect(readFingerprints(path.join(repo, 'none.ts'))).toEqual([]);
    fs.writeFileSync(path.join(repo, 'bin'), Buffer.from([1, 0, 2]));
    expect(readFingerprints(path.join(repo, 'bin'))).toBeNull();
    fs.writeFileSync(path.join(repo, 'big'), 'a'.repeat(MAX_FILE_BYTES + 1));
    expect(readFingerprints(path.join(repo, 'big'))).toBeNull();
  });
});

describe('编辑类基线', () => {
  beforeEach(() => tmpHome());
  it('只返回新增的行', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.ts'), 'keep\n');
    const b = captureEditBaseline(repo, 'a.ts')!;
    fs.writeFileSync(path.join(repo, 'a.ts'), 'keep\nadded\n');
    expect(editChanges(b)).toEqual([{ repoRoot: repo, rel: 'a.ts', fps: fingerprintText('added') }]);
  });
});

describe('shell 类基线', () => {
  beforeEach(() => tmpHome());
  it('只统计执行期间的变化，排除执行前已有的人工改动和被忽略的文件', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.ts'), 'base\n');
    commitAll(repo, 'init');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'base\nhuman line\n'); // 执行前的人工改动
    const ignored = buildIgnore(repo, []);
    const b = captureShellBaseline(repo, ignored, far())!;
    fs.writeFileSync(path.join(repo, 'a.ts'), 'base\nhuman line\nai line\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'new file line\n');
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"x": 1}\n');
    const changes = shellChanges(b, ignored, far()).sort((x, y) => x.rel.localeCompare(y.rel));
    expect(changes).toEqual([
      { repoRoot: repo, rel: 'a.ts', fps: fingerprintText('ai line') },
      { repoRoot: repo, rel: 'b.ts', fps: fingerprintText('new file line') },
    ]);
  });

  it('执行前未改动的已跟踪文件，以 HEAD 版本为基线', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'c.ts'), 'one\n');
    commitAll(repo, 'init');
    const ignored = buildIgnore(repo, []);
    const b = captureShellBaseline(repo, ignored, far())!;
    fs.writeFileSync(path.join(repo, 'c.ts'), 'one\ntwo\n');
    expect(shellChanges(b, ignored, far())).toEqual([{ repoRoot: repo, rel: 'c.ts', fps: fingerprintText('two') }]);
  });

  it('超出时间预算抛出 BudgetExceeded', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'x.ts'), 'x\n');
    expect(() => captureShellBaseline(repo, buildIgnore(repo, []), Date.now() - 1)).toThrow(BudgetExceeded);
  });

  it('即使没有改动文件，deadline 已过期时也会在 statusPaths 阶段抛出（而不仅是逐文件循环里）', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.ts'), 'a\n');
    commitAll(repo, 'init'); // 干净仓库，git status 没有任何变化，逐文件循环不会执行
    expect(() => captureShellBaseline(repo, buildIgnore(repo, []), Date.now() - 1)).toThrow(BudgetExceeded);
  });
});

describe('pending', () => {
  beforeEach(() => tmpHome());
  it('take 只能取一次并留下 .done 标记；cleanup 清理过期的 pending 与 .done', () => {
    const key = 'claude-code_s/1_t:1';
    savePending(key, { kind: 'edit', repoRoot: '/r', rel: 'a', fps: [] });
    expect(hasPending(key)).toBe(true);
    expect(isDone(key)).toBe(false);
    expect(takePending(key)).toEqual({ kind: 'edit', repoRoot: '/r', rel: 'a', fps: [] });
    expect(takePending(key)).toBeNull();
    expect(hasPending(key)).toBe(false);
    expect(isDone(key)).toBe(true);
    savePending('old', { kind: 'edit', repoRoot: '/r', rel: 'a', fps: [] });
    const old = new Date(Date.now() - 2 * 3600_000);
    for (const name of fs.readdirSync(pendingDir())) fs.utimesSync(path.join(pendingDir(), name), old, old);
    cleanupPending();
    expect(fs.readdirSync(pendingDir())).toEqual([]);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIgnore } from '../src/ignore.js';
import { commitAll, initRepo, tmpHome } from './helpers.js';

// showFile 经 tryGit 转发：进程被 ETIMEDOUT 杀掉时也返回 null，和"文件不在 HEAD 中（新文件）"无法直接区分。
// 用一个会在返回前把 deadline 耗尽的 showFile 模拟这种超时场景。
vi.mock('../src/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/git.js')>();
  return {
    ...actual,
    showFile: (_root: string, _rev: string, _rel: string, timeoutMs?: number) => {
      // 忙等到 timeoutMs（即调用时刻的剩余预算）之后再返回，确定性地让调用方的 deadline
      // 在这次调用返回时已经过期，模拟真实的 ETIMEDOUT 场景
      const until = Date.now() + (timeoutMs ?? 0) + 20;
      while (Date.now() < until) {
        // 忙等
      }
      return null;
    },
  };
});

describe('shellChanges：showFile 超时不应被当作新文件', () => {
  beforeEach(() => tmpHome());

  it('showFile 超时（deadline 在调用期间耗尽）时抛出 BudgetExceeded，且不记录任何改动', async () => {
    const { BudgetExceeded, captureShellBaseline, shellChanges } = await import('../src/snapshot.js');
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.ts'), 'base\n');
    commitAll(repo, 'init');
    const ignored = buildIgnore(repo, []);
    const b = captureShellBaseline(repo, ignored, Date.now() + 60_000)!;
    // 新增未跟踪文件，触发对 HEAD 版本（showFile）的基线查询
    fs.writeFileSync(path.join(repo, 'b.ts'), 'new file line\n');
    const deadline = Date.now() + 100; // 足够让 checkDeadline 先通过，再在 showFile 的忙等后过期
    expect(() => shellChanges(b, ignored, deadline)).toThrow(BudgetExceeded);
  });
});

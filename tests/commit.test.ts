import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCommit } from '../src/commit.js';
import { fingerprintText } from '../src/fingerprint.js';
import { repoId, repoKey } from '../src/git.js';
import { appendRecords, readRecords, type LedgerRecord } from '../src/ledger.js';
import { eventsPath } from '../src/paths.js';
import { commitAll, initRepo, sh, tmpHome } from './helpers.js';

beforeEach(() => tmpHome());
const now = () => Math.floor(Date.now() / 1000);
const aiRecords = (p: string, text: string, ts = now()): LedgerRecord[] =>
  fingerprintText(text).map((f) => ({ p, f, t: 'claude-code', m: 'opus', s: 's1', ts }));

describe('runCommit', () => {
  it('统计 AI 行与人工行，消费 ledger 并写入 events.jsonl', async () => {
    const repo = initRepo();
    sh(repo, ['remote', 'add', 'origin', 'git@gitlab.example.com:group/proj.git']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'init\n');
    commitAll(repo, 'init');
    sh(repo, ['checkout', '-q', '-b', 'feature/login']);
    const key = repoKey(repoId(repo));
    appendRecords(key, [...aiRecords('src/a.ts', 'const a = 1;\nconst b = 2;'), ...aiRecords('src/a.ts', 'stale', now() - 8 * 86400)]);
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const sha = commitAll(repo, 'feat: 登录');

    const event = await runCommit(repo);

    expect(event).toMatchObject({
      event_id: `gitlab.example.com/group/proj:${sha}`,
      repo: 'gitlab.example.com/group/proj',
      branch: 'feature/login',
      commit_sha: sha,
      commit_message: 'feat: 登录',
      amend: false,
      owner: { name: 'Tester', email: 'tester@example.com' },
      module: 'login',
      files: [{ path: 'src/a.ts', module: 'login', added: 3, ai: 2 }],
    });
    expect(event!.stats).toMatchObject({ added_total: 3, added_ai: 2, added_human: 1, ai_generated: 3 });
    // 已消费的记录不再删除，改为标记归属本次 commit（供 amend 时借回）；过期的被清理
    expect(readRecords(key)).toEqual([
      expect.objectContaining({ p: 'src/a.ts', c: sha }),
      expect.objectContaining({ p: 'src/a.ts', c: sha }),
    ]);
    expect(fs.readFileSync(eventsPath(), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('amend 保留原有 AI 行的归属：追加人工行后统计仍把原 AI 行计为 AI', async () => {
    const repo = initRepo();
    const key = repoKey(repoId(repo));
    appendRecords(key, aiRecords('a.ts', 'const a = 1;\nconst b = 2;'));
    fs.writeFileSync(path.join(repo, 'a.ts'), 'const a = 1;\nconst b = 2;\n');
    commitAll(repo, 'feat: 初次提交');
    const beforeAmend = await runCommit(repo);
    expect(beforeAmend!.stats).toMatchObject({ added_ai: 2, added_human: 0 });

    fs.writeFileSync(path.join(repo, 'a.ts'), 'const a = 1;\nconst b = 2;\nconst human = true;\n');
    sh(repo, ['commit', '-q', '-a', '--amend', '-m', 'feat: 初次提交（amend）']);
    const afterAmend = await runCommit(repo);

    expect(afterAmend).not.toBeNull();
    expect(afterAmend!.amend).toBe(true);
    expect(afterAmend!.stats).toMatchObject({ added_total: 3, added_ai: 2, added_human: 1 });
  });

  it('同一 commit 不重复统计', async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'init');
    expect(await runCommit(repo)).not.toBeNull();
    expect(await runCommit(repo)).toBeNull();
  });

  it('跳过 merge commit', async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'init');
    sh(repo, ['checkout', '-q', '-b', 'feature/x']);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    commitAll(repo, 'b');
    sh(repo, ['checkout', '-q', 'master']);
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    commitAll(repo, 'c');
    sh(repo, ['merge', '-q', '--no-ff', '-m', 'merge', 'feature/x']);
    expect(await runCommit(repo)).toBeNull();
  });

  it('不在 git 仓库时返回 null', async () => {
    expect(await runCommit(process.env.HOME!)).toBeNull();
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildStatusArgs, commitDiff, commitInfo, currentBranch, isAmend, normalizeRemote, parseUnifiedDiff, repoId, repoKey,
  repoRoot, repoRootForPath, showFile, statusPaths, toRepoRelative,
} from '../src/git.js';
import { commitAll, initRepo, sh } from './helpers.js';

describe('normalizeRemote', () => {
  it.each([
    ['git@gitlab.example.com:group/proj.git', 'gitlab.example.com/group/proj'],
    ['ssh://git@gitlab.example.com:2222/group/sub/proj.git', 'gitlab.example.com/group/sub/proj'],
    ['https://user@gitlab.example.com/group/proj.git', 'gitlab.example.com/group/proj'],
    ['https://gitlab.example.com/group/proj', 'gitlab.example.com/group/proj'],
  ])('%s', (url, expected) => expect(normalizeRemote(url)).toBe(expected));
});

describe('parseUnifiedDiff', () => {
  it('解析新增、删除、新文件、删除文件、重命名与二进制', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1,2 @@',
      '-old',
      '+new1',
      '+++not header',
      'diff --git a/n.ts b/n.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/n.ts',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n');
    expect(parseUnifiedDiff(text)).toEqual([
      { path: 'src/a.ts', oldPath: null, added: ['new1', '++not header'], deleted: 1, binary: false },
      { path: 'n.ts', oldPath: null, added: ['hello'], deleted: 0, binary: false },
      { path: 'gone.ts', oldPath: null, added: [], deleted: 2, binary: false },
      { path: 'new.ts', oldPath: 'old.ts', added: ['b'], deleted: 1, binary: false },
      { path: 'img.png', oldPath: null, added: [], deleted: 0, binary: true },
    ]);
  });

  it('去引号时按 UTF-8 正确还原原始非 ASCII 字符（core.quotepath=false）（见 R5）', () => {
    const text = [
      'diff --git a/x b/x',
      '+++ "b/中文\\"x.ts"',
    ].join('\n');
    expect(parseUnifiedDiff(text)[0].path).toBe('中文"x.ts');
  });
});

describe('仓库操作', () => {
  it('repoRoot / repoId / repoKey / currentBranch', () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, 'sub'));
    expect(repoRoot(path.join(repo, 'sub'))).toBe(repo);
    expect(repoId(repo)).toBe(`local:${repo}`);
    sh(repo, ['remote', 'add', 'origin', 'git@gitlab.example.com:group/proj.git']);
    expect(repoId(repo)).toBe('gitlab.example.com/group/proj');
    expect(repoKey('gitlab.example.com/group/proj')).toMatch(/^[0-9a-f]{16}$/);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'init');
    sh(repo, ['checkout', '-q', '-b', 'feature/login']);
    expect(currentBranch(repo)).toBe('feature/login');
  });

  it('repoRootForPath / toRepoRelative 支持尚不存在的文件', () => {
    const repo = initRepo();
    const abs = path.join(repo, 'x', 'y', 'z.ts');
    expect(repoRootForPath(abs)).toBe(repo);
    expect(toRepoRelative(repo, abs)).toBe('x/y/z.ts');
    expect(repoRootForPath('/definitely/not/here/a.ts')).toBeNull();
  });

  it('buildStatusArgs 带 --no-optional-locks，避免与用户操作竞争 .git/index.lock', () => {
    const args = buildStatusArgs();
    expect(args[0]).toBe('--no-optional-locks');
    expect(args).toContain('status');
  });

  it('statusPaths 列出改动、未跟踪文件和重命名后的新路径', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'r.txt'), 'r\n');
    commitAll(repo, 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a2\n');
    fs.mkdirSync(path.join(repo, 'd'));
    fs.writeFileSync(path.join(repo, 'd', 'new file.txt'), 'n\n');
    sh(repo, ['mv', 'r.txt', 'r2.txt']);
    expect(statusPaths(repo).sort()).toEqual(['a.txt', 'd/new file.txt', 'r2.txt']);
  });

  it('showFile / commitInfo / commitDiff / isAmend', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\n');
    const sha1 = commitAll(repo, 'feat: 第一次');
    expect(showFile(repo, 'HEAD', 'a.txt')).toBe('line1\n');
    expect(showFile(repo, 'HEAD', 'missing.txt')).toBeNull();
    const info = commitInfo(repo, 'HEAD');
    expect(info).toMatchObject({ sha: sha1, parents: [], authorName: 'Tester', authorEmail: 'tester@example.com', message: 'feat: 第一次' });
    expect(info.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(commitDiff(repo, sha1)).toEqual([{ path: 'a.txt', oldPath: null, added: ['line1'], deleted: 0, binary: false }]);
    expect(isAmend(repo)).toBe(false);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2\n');
    sh(repo, ['commit', '-q', '-a', '--amend', '-m', 'feat: 修改']);
    expect(isAmend(repo)).toBe(true);
  });

  it('commitDiff 能处理带空格的路径', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'new file.txt'), 'a\n');
    const sha = commitAll(repo, 'feat: 空格路径');
    expect(commitDiff(repo, sha)).toEqual([{ path: 'new file.txt', oldPath: null, added: ['a'], deleted: 0, binary: false }]);
  });

  it('commitDiff 能处理带双引号的路径（新建与重命名）', () => {
    const repo = initRepo();
    const quoted = 'a"b.ts';
    fs.writeFileSync(path.join(repo, quoted), 'x\n');
    const sha1 = commitAll(repo, 'feat: 引号路径');
    expect(commitDiff(repo, sha1)).toEqual([{ path: quoted, oldPath: null, added: ['x'], deleted: 0, binary: false }]);

    const renamed = 'b"c.ts';
    sh(repo, ['mv', quoted, renamed]);
    const sha2 = commitAll(repo, 'feat: 引号路径重命名');
    expect(commitDiff(repo, sha2)).toEqual([{ path: renamed, oldPath: quoted, added: [], deleted: 0, binary: false }]);

    fs.unlinkSync(path.join(repo, renamed));
    const sha3 = commitAll(repo, 'feat: 删除引号路径');
    expect(commitDiff(repo, sha3)).toEqual([{ path: renamed, oldPath: null, added: [], deleted: 1, binary: false }]);
  });

  it('commitDiff 在 core.quotepath 默认开启时能处理非 ASCII 路径', () => {
    const repo = initRepo();
    // 不设置 core.quotepath，使用 git 默认值（true，非 ASCII 字节会被引号+八进制转义）
    const name = '文件.txt';
    fs.writeFileSync(path.join(repo, name), '内容\n');
    const sha = commitAll(repo, 'feat: 中文路径');
    expect(commitDiff(repo, sha)).toEqual([{ path: name, oldPath: null, added: ['内容'], deleted: 0, binary: false }]);
  });
});

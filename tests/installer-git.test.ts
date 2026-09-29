import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { gitCommonDir, isTracked, localHooksPath } from '../src/git.js';
import { addExclude, removeExclude } from '../src/installer/exclude.js';
import {
  HOOK_NAMES, installGitHooks, installProjectGitHook, projectHookPath, renderForwarder, renderProjectPostCommit,
  uninstallGitHooks, uninstallProjectGitHook,
} from '../src/installer/git.js';
import { shq } from '../src/installer/shell.js';
import { gitHooksDir } from '../src/paths.js';
import { commitAll, initRepo, sh, tmpHome } from './helpers.js';

/** 按提交信息找到对应的 sha：commitAll 的返回值是 `git commit` 之后的 HEAD，
 * 如果 post-commit 里的原 hook 又提交并切换了分支，届时 HEAD 已经不是这次提交了 */
function revOfMessage(repo: string, message: string): string {
  const lines = sh(repo, ['log', '--all', '--format=%H%x09%s']).split('\n');
  const line = lines.find((l) => l.endsWith(`\t${message}`));
  if (!line) throw new Error(`未找到提交信息为 ${message} 的提交`);
  return line.split('\t')[0];
}

/** 轮询等待后台统计进程写完文件（capture 是同步的，后台进程通常几毫秒内完成） */
function waitForFile(file: string, timeoutMs = 2000): string {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.trim()) return content;
    }
  }
  throw new Error(`等待文件超时: ${file}`);
}

let home: string;
beforeEach(() => {
  home = tmpHome();
});
const globalHooksPath = () => {
  try {
    return execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], { cwd: home, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

describe('git 辅助函数', () => {
  it('gitCommonDir / isTracked / localHooksPath', () => {
    const repo = initRepo();
    expect(gitCommonDir(repo)).toBe(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'init');
    expect(isTracked(repo, 'a.txt')).toBe(true);
    expect(isTracked(repo, 'b.txt')).toBe(false);
    expect(localHooksPath(repo)).toBeNull();
    sh(repo, ['config', 'core.hooksPath', '.husky/_']);
    expect(localHooksPath(repo)).toBe('.husky/_');
  });
});

describe('exclude', () => {
  it('写入标记区块，重复写入幂等，移除后还原', () => {
    const repo = initRepo();
    const file = path.join(repo, '.git', 'info', 'exclude');
    const original = fs.readFileSync(file, 'utf8');
    addExclude(repo, ['/.claude/settings.local.json']);
    addExclude(repo, ['/.claude/settings.local.json', '/.codex/config.toml']);
    const text = fs.readFileSync(file, 'utf8');
    expect(text.match(/# >>> aicode >>>/g)).toHaveLength(1);
    expect(text).toContain('/.codex/config.toml');
    fs.mkdirSync(path.join(repo, '.codex'));
    fs.writeFileSync(path.join(repo, '.codex', 'config.toml'), 'x\n');
    expect(sh(repo, ['status', '--porcelain'])).toBe('');
    removeExclude(repo);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});

describe('HOOK_NAMES', () => {
  it('包含服务端与 Perforce 钩子，不含 push-to-checkout（见 F7）', () => {
    for (const name of [
      'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update', 'post-index-change',
      'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit',
    ]) {
      expect(HOOK_NAMES).toContain(name);
    }
    expect(HOOK_NAMES).not.toContain('push-to-checkout');
  });
});

describe('全局模式', () => {
  it('只有 post-commit 会额外在后台启动统计，且同步捕获本次 commit 的信息', () => {
    const post = renderForwarder('post-commit', null, "'node' 'cli' commit");
    expect(post).toContain('SHA=$(git rev-parse HEAD 2>/dev/null)');
    expect(post).toContain("( 'node' 'cli' commit --sha \"$SHA\" --branch \"$BRANCH\" --reflog \"$REFLOG\" --prev \"$PREV\" </dev/null >/dev/null 2>&1 & )");
    expect(renderForwarder('pre-commit', null, "'node' 'cli' commit")).not.toContain('commit --sha');
  });

  it('设置全局 hooksPath，转发到仓库自有 hook 并保留其退出码', () => {
    installGitHooks();
    expect(globalHooksPath()).toBe(gitHooksDir());
    const repo = initRepo();
    const local = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(local, '#!/bin/sh\necho blocked >&2\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    sh(repo, ['add', '-A']);
    expect(() => sh(repo, ['commit', '-q', '-m', 'x'])).toThrow();
    fs.unlinkSync(local);
    expect(() => sh(repo, ['commit', '-q', '-m', 'x'])).not.toThrow();
  });

  it('原来已有全局 hooksPath 时，转发到原路径；卸载后恢复原值', () => {
    const prev = path.join(home, 'my-hooks');
    fs.mkdirSync(prev);
    execFileSync('git', ['config', '--global', 'core.hooksPath', prev], { cwd: home });
    installGitHooks();
    installGitHooks(); // 重复安装时不会把自身记为原路径
    expect(fs.readFileSync(path.join(gitHooksDir(), 'pre-commit'), 'utf8')).toContain(prev);
    uninstallGitHooks();
    expect(globalHooksPath()).toBe(prev);
  });

  it('原来没有全局 hooksPath 时，卸载后删除该配置', () => {
    installGitHooks();
    uninstallGitHooks();
    expect(globalHooksPath()).toBeNull();
    expect(fs.existsSync(gitHooksDir())).toBe(false);
  });

  it('在调用原 hook 之前捕获本次 commit 的身份：原 hook 自己又提交并切换分支也不影响记录（见 R2）', () => {
    const repo = initRepo();
    const branch = sh(repo, ['symbolic-ref', '--short', 'HEAD']).trim();
    const prevDir = path.join(repo, '..', `prev-hooks-${path.basename(repo)}`);
    fs.mkdirSync(prevDir);
    const installedHook = path.join(repo, '.git', 'hooks', 'post-commit');
    // 原 hook：先造出第二个提交，再切到新分支——如果捕获发生在调用它之后，就会读到这里的 sha/branch。
    // 临时去掉安装的 hook 的可执行权限，避免这里造的第二个提交递归触发同一个 post-commit
    fs.writeFileSync(
      path.join(prevDir, 'post-commit'),
      `#!/bin/sh\nchmod -x ${shq(installedHook)}\ngit commit --allow-empty -q -m second\ngit checkout -q -b other\nchmod +x ${shq(installedHook)}\n`,
      { mode: 0o755 },
    );
    const outFile = path.join(repo, '..', `out-${path.basename(repo)}`);
    const fakeCommit = path.join(repo, '..', `fake-commit-${path.basename(repo)}`);
    fs.writeFileSync(fakeCommit, `#!/bin/sh\necho "$@" >> ${shq(outFile)}\n`, { mode: 0o755 });
    fs.writeFileSync(installedHook, renderForwarder('post-commit', prevDir, fakeCommit), { mode: 0o755 });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'first');
    const sha1 = revOfMessage(repo, 'first');
    const recorded = waitForFile(outFile);
    expect(recorded).toContain(`--sha ${sha1}`);
    expect(recorded).toContain(`--branch ${branch}`);
  });
});

describe('项目模式', () => {
  it('保留并调用原有 post-commit，可重复安装，卸载后还原', () => {
    const repo = initRepo();
    const hook = projectHookPath(repo);
    const marker = path.join(repo, '..', `marker-${path.basename(repo)}`);
    const original = `#!/bin/sh\necho ran > '${marker}'\n`;
    fs.writeFileSync(hook, original, { mode: 0o755 });
    installProjectGitHook(repo);
    installProjectGitHook(repo);
    expect(fs.readFileSync(hook + '.aicode-orig', 'utf8')).toBe(original);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'init');
    expect(fs.existsSync(marker)).toBe(true);
    uninstallProjectGitHook(repo);
    expect(fs.readFileSync(hook, 'utf8')).toBe(original);
    expect(fs.existsSync(hook + '.aicode-orig')).toBe(false);
  });

  it('原来没有 post-commit 时，卸载后删除', () => {
    const repo = initRepo();
    installProjectGitHook(repo);
    expect(fs.readFileSync(projectHookPath(repo), 'utf8')).toContain('# aicode project post-commit');
    uninstallProjectGitHook(repo);
    expect(fs.existsSync(projectHookPath(repo))).toBe(false);
  });

  it('安装时：hook 已被其他工具替换且已存在旧的 .aicode-orig 备份，拒绝覆盖并报错（见 F6）', () => {
    const repo = initRepo();
    const hook = projectHookPath(repo);
    fs.writeFileSync(hook, '#!/bin/sh\necho mine\n', { mode: 0o755 });
    fs.writeFileSync(hook + '.aicode-orig', '#!/bin/sh\necho stale-backup\n', { mode: 0o755 });
    expect(() => installProjectGitHook(repo)).toThrow(/post-commit 已被其他工具替换/);
    // 拒绝后不能改动现场
    expect(fs.readFileSync(hook, 'utf8')).toContain('echo mine');
    expect(fs.readFileSync(hook + '.aicode-orig', 'utf8')).toContain('echo stale-backup');
  });

  it('卸载时：hook 已被其他工具替换（非 aicode），不删除对方的 hook，也不用旧备份覆盖它（见 F6）', () => {
    const repo = initRepo();
    const hook = projectHookPath(repo);
    fs.writeFileSync(hook, '#!/bin/sh\necho original\n', { mode: 0o755 }); // 仓库原有的 hook
    installProjectGitHook(repo); // 正常安装，把原有 hook 备份为 .aicode-orig
    fs.writeFileSync(hook, '#!/bin/sh\necho replaced-by-other-tool\n', { mode: 0o755 }); // 之后被其他工具替换
    uninstallProjectGitHook(repo);
    expect(fs.readFileSync(hook, 'utf8')).toContain('echo replaced-by-other-tool'); // 对方的 hook 原样保留
    expect(fs.existsSync(hook + '.aicode-orig')).toBe(true); // 备份也保留，交给用户手动处理
  });

  it('在调用原 post-commit 之前捕获本次 commit 的身份：原 hook 自己又提交并切换分支也不影响记录（见 R2）', () => {
    const repo = initRepo();
    const branch = sh(repo, ['symbolic-ref', '--short', 'HEAD']).trim();
    const hook = projectHookPath(repo);
    const origScript = path.join(repo, '..', `orig-${path.basename(repo)}`);
    // 原 hook：先造出第二个提交，再切到新分支——如果捕获发生在调用它之后，就会读到这里的 sha/branch。
    // 临时去掉安装的 hook 的可执行权限，避免这里造的第二个提交递归触发同一个 post-commit
    fs.writeFileSync(
      origScript,
      `#!/bin/sh\nchmod -x ${shq(hook)}\ngit commit --allow-empty -q -m second\ngit checkout -q -b other\nchmod +x ${shq(hook)}\n`,
      { mode: 0o755 },
    );
    const outFile = path.join(repo, '..', `out-${path.basename(repo)}`);
    const fakeCommit = path.join(repo, '..', `fake-commit-${path.basename(repo)}`);
    fs.writeFileSync(fakeCommit, `#!/bin/sh\necho "$@" >> ${shq(outFile)}\n`, { mode: 0o755 });
    fs.writeFileSync(hook, renderProjectPostCommit(origScript, fakeCommit), { mode: 0o755 });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'first');
    const sha1 = revOfMessage(repo, 'first');
    const recorded = waitForFile(outFile);
    expect(recorded).toContain(`--sha ${sha1}`);
    expect(recorded).toContain(`--branch ${branch}`);
  });
});

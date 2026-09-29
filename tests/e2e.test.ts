import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { commitAll, initRepo, sh, tmpHome } from './helpers.js';

const CLI = path.resolve('dist/cli.js');
let home: string;
beforeEach(() => {
  home = tmpHome();
});

const run = (args: string[], input?: unknown, cwd?: string) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    input: input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });

const readEvents = () => {
  const p = path.join(home, '.aicode', 'events.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

async function waitForEvent(sha: string, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const e = readEvents().find((x) => x.commit_sha === sha);
    if (e) return e;
    if (Date.now() > end) throw new Error('等待统计事件超时');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 模拟 AI：Claude 用 Write 新建 3 行；Codex 用 exec 新建 1 行；人工改 1 行、加 1 行 */
function simulateAiAndHuman(repo: string) {
  const file = path.join(repo, 'src', 'a.ts');
  const edit = { session_id: 's1', tool_use_id: 'e1', cwd: repo, tool_name: 'Write', tool_input: { file_path: file, content: '' } };
  run(['hook', 'pre', '--tool', 'claude'], edit);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  run(['hook', 'post', '--tool', 'claude'], edit);
  const exec = { session_id: 'c1', tool_use_id: 'b1', cwd: repo, tool_name: 'exec', model: 'gpt-x' };
  run(['hook', 'pre', '--tool', 'codex'], exec);
  fs.writeFileSync(path.join(repo, 'b.ts'), 'shell line\n');
  run(['hook', 'post', '--tool', 'codex'], exec);
  fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\nconst c = 30;\nconst human = true;\n');
}

describe('端到端', () => {
  it('全局模式：init --yes → 钩子采集 → 人工修改 → git commit → 生成事件', async () => {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n');
    expect(run(['init', '--yes']).status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toContain('# >>> aicode hooks >>>');
    expect(fs.statSync(path.join(home, '.aicode', 'config.json')).mode & 0o777).toBe(0o600);

    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'README.md'), 'init\n');
    commitAll(repo, 'init');
    simulateAiAndHuman(repo);
    const sha = commitAll(repo, 'feat: e2e');

    const event = await waitForEvent(sha);
    expect(event.stats).toMatchObject({ added_total: 5, added_ai: 3, added_human: 2, ai_generated: 4 });
    expect(Object.keys(event.stats.by_tool).sort()).toEqual(['claude-code/unknown', 'codex/gpt-x']);
  });

  it('全局 + 项目模式同时安装时，AI 行和事件都不重复', async () => {
    run(['init', '--yes']);
    const repo = initRepo();
    expect(run(['init', '--local', '--yes'], undefined, repo).status).toBe(0);
    fs.writeFileSync(path.join(repo, 'README.md'), 'init\n');
    commitAll(repo, 'init');
    // 两套钩子各触发一次：pre、pre、post、post
    const file = path.join(repo, 'x.ts');
    const edit = { session_id: 's', tool_use_id: 'd1', cwd: repo, tool_name: 'Write', tool_input: { file_path: file, content: 'ai\n' } };
    run(['hook', 'pre', '--tool', 'claude'], edit);
    run(['hook', 'pre', '--tool', 'claude'], edit);
    fs.writeFileSync(file, 'ai\n');
    run(['hook', 'post', '--tool', 'claude'], edit);
    run(['hook', 'post', '--tool', 'claude'], edit);
    const sha = commitAll(repo, 'feat: dup');
    const event = await waitForEvent(sha);
    await new Promise((r) => setTimeout(r, 1000)); // 等第二个后台统计进程结束
    expect(readEvents().filter((e) => e.commit_sha === sha)).toHaveLength(1);
    expect(event.stats).toMatchObject({ added_ai: 1, ai_generated: 1 });
  });

  it('非交互环境下没有 --yes 时中止，且不写入任何文件', () => {
    const r = run(['init']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--yes');
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('未知参数 --project 被拒绝，退出码为 1，不创建文件', () => {
    const r = run(['init', '--project', '--yes']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('未知参数');
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('hook 输入损坏时退出码仍为 0，并写入日志', () => {
    expect(run(['hook', 'pre', '--tool', 'claude'], '{bad').status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.aicode', 'logs', 'aicode.log'), 'utf8')).toContain('[hook]');
  });

  it('post-commit 同步捕获本次 commit 的 sha/分支，连续提交或提交后立即切换分支都不出错', async () => {
    expect(run(['init', '--yes']).status).toBe(0);
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'init');

    // 一行 shell 内连续两次 commit：旧实现在后台读 HEAD 会把 c1 丢掉
    fs.writeFileSync(path.join(repo, 'a.txt'), 'b\n');
    sh(repo, ['add', '-A']);
    execFileSync('sh', ['-c', 'git commit -q -m c1 && echo c >> a.txt && git add -A && git commit -q -m c2'], { cwd: repo });
    const sha1 = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repo, encoding: 'utf8' }).trim();
    const sha2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const e1 = await waitForEvent(sha1);
    const e2 = await waitForEvent(sha2);
    expect(e1.commit_sha).toBe(sha1);
    expect(e2.commit_sha).toBe(sha2);

    // commit 后立即切换分支：事件应记录提交时所在的分支，而不是切换后的分支
    fs.writeFileSync(path.join(repo, 'a.txt'), 'd\n');
    sh(repo, ['add', '-A']);
    execFileSync('sh', ['-c', 'git commit -q -m c3 && git checkout -q -b other'], { cwd: repo });
    const sha3 = execFileSync('git', ['rev-parse', 'other'], { cwd: repo, encoding: 'utf8' }).trim();
    const e3 = await waitForEvent(sha3);
    expect(e3.branch).toBe('master');
  });

  it('init --uninstall --yes 移除全部钩子', () => {
    run(['init', '--yes']);
    expect(run(['init', '--uninstall', '--yes']).status).toBe(0);
    expect(() => execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], { cwd: home, env: { ...process.env, HOME: home } })).toThrow();
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false); // 由 aicode 创建，卸载时删除
  });
});

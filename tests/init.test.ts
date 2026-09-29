import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { planGlobal, planProject } from '../src/init.js';
import { commitAll, initRepo, sh, tmpHome } from './helpers.js';

let home: string;
beforeEach(() => {
  home = tmpHome();
});
const applyAll = (plan: { steps: { apply: () => void }[] }) => plan.steps.forEach((s) => s.apply());

describe('planGlobal', () => {
  it('未安装 Codex 时不包含 Codex 步骤，并给出提示', () => {
    const plan = planGlobal(false);
    expect(plan.steps.map((s) => s.file)).toEqual([
      path.join(home, '.aicode', 'config.json'),
      path.join(home, '.claude', 'settings.json'),
      '~/.gitconfig（core.hooksPath）',
    ]);
    expect(plan.notes.join('\n')).toContain('未检测到 Codex');
  });

  it('安装时提示 pre-commit 限制与 node 路径写死的注意事项（见 F7）', () => {
    const notes = planGlobal(false).notes.join('\n');
    expect(notes).toContain('pre-commit');
    expect(notes).toContain('aicode init');
  });

  it('~/.aicode 目录权限设为 700，已存在时也会收紧（见 F8）', () => {
    fs.mkdirSync(path.join(home, '.aicode'), { recursive: true, mode: 0o755 });
    applyAll(planGlobal(false));
    expect(fs.statSync(path.join(home, '.aicode')).mode & 0o777).toBe(0o700);
  });
});

describe('planProject', () => {
  it('不在 git 仓库中时报错', () => {
    expect(() => planProject(home, false)).toThrow('当前目录不在 git 仓库中');
  });

  it('安装 Claude、已信任项目的 Codex、exclude 和 post-commit；卸载后全部还原', () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(home, '.codex'));
    const globalCodex = `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`;
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), globalCodex);
    const excludeBefore = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');

    const plan = planProject(repo, false);
    expect(plan.steps.map((s) => path.relative(repo, s.file))).toEqual(
      expect.arrayContaining(['.claude/settings.local.json', '.codex/config.toml', '.git/info/exclude', '.git/hooks/post-commit']),
    );
    applyAll(plan);
    expect(fs.existsSync(path.join(repo, '.claude', 'settings.local.json'))).toBe(true);
    expect(fs.readFileSync(path.join(repo, '.codex', 'config.toml'), 'utf8')).toContain('# >>> aicode hooks >>>');
    expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toContain('# >>> aicode trust ');
    expect(sh(repo, ['status', '--porcelain'])).toBe('');

    applyAll(planProject(repo, true));
    expect(fs.existsSync(path.join(repo, '.claude', 'settings.local.json'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.codex', 'config.toml'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe(excludeBefore);
    expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toBe(globalCodex);
  });

  it('已有未跟踪的 settings.local.json 时，安装期间产生的 .aicode.bak 被 exclude 忽略；卸载后不留 .bak（见 F5）', () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{"model":"opus"}\n');

    applyAll(planProject(repo, false));
    expect(fs.existsSync(path.join(repo, '.claude', 'settings.local.json.aicode.bak'))).toBe(true);
    expect(sh(repo, ['status', '--porcelain'])).toBe(''); // .bak 已被 exclude，不出现在 git status 中

    applyAll(planProject(repo, true));
    expect(fs.existsSync(path.join(repo, '.claude', 'settings.local.json.aicode.bak'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'))).toEqual({ model: 'opus' });
  });

  it('卸载时已被 git 跟踪的配置文件保持不变，并给出提示（见 F5）', () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, '.claude'));
    const original = '{"model":"opus"}\n';
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), original);
    commitAll(repo, 'track settings');

    const plan = planProject(repo, true);
    expect(plan.steps.map((s) => path.relative(repo, s.file))).not.toContain('.claude/settings.local.json');
    expect(plan.notes.join('\n')).toContain('已被 git 跟踪');
    applyAll(plan);
    expect(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8')).toBe(original);
  });

  it('在 linked worktree 中，展示的 exclude 路径使用公共 git 目录（见 F8）', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'init');
    const wt = path.join(repo, '..', `wt-${path.basename(repo)}`);
    // 用 execFileSync 而非 sh，以便屏蔽 git worktree add 直接写终端的进度提示（stdio: ignore）
    execFileSync('git', ['worktree', 'add', wt, '-b', 'wt-branch'], { cwd: repo, stdio: 'ignore' });
    const plan = planProject(wt, false);
    const excludeStep = plan.steps.find((s) => s.file.endsWith(path.join('info', 'exclude')));
    expect(excludeStep?.file).toBe(path.join(repo, '.git', 'info', 'exclude'));
  });

  it('卸载时 post-commit 已被其他工具替换：提示用户手动处理，且不覆盖对方的 hook（见 F6）', () => {
    const repo = initRepo();
    const hookFile = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(hookFile, '#!/bin/sh\necho original\n', { mode: 0o755 }); // 仓库原有的 hook
    applyAll(planProject(repo, false)); // 安装时把原有 hook 备份为 .aicode-orig
    fs.writeFileSync(hookFile, '#!/bin/sh\necho replaced-by-other-tool\n', { mode: 0o755 }); // 之后被其他工具替换

    const plan = planProject(repo, true);
    expect(plan.notes.join('\n')).toContain('已被其他工具替换');
    applyAll(plan);
    expect(fs.readFileSync(hookFile, 'utf8')).toContain('echo replaced-by-other-tool');
    expect(fs.existsSync(hookFile + '.aicode-orig')).toBe(true);
  });

  it('安装前检测到 post-commit 冲突（已被其他工具替换且存在旧备份）时立即报错，不写入任何文件（见 R4）', () => {
    const repo = initRepo();
    const hookFile = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(hookFile, '#!/bin/sh\necho mine\n', { mode: 0o755 });
    fs.writeFileSync(hookFile + '.aicode-orig', '#!/bin/sh\necho stale-backup\n', { mode: 0o755 });

    expect(() => planProject(repo, false)).toThrow(/post-commit 已被其他工具替换/);
    // 报错前不能写入任何文件：既不能碰 ~/.aicode，也不能碰仓库里的其他配置
    expect(fs.existsSync(path.join(home, '.aicode'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
    expect(fs.readFileSync(hookFile, 'utf8')).toContain('echo mine');
    expect(fs.readFileSync(hookFile + '.aicode-orig', 'utf8')).toContain('echo stale-backup');
  });

  it('跳过已被 git 跟踪的配置文件和未信任的 Codex 项目，并提示仓库级 hooksPath', () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{}\n');
    commitAll(repo, 'track settings');
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n');
    sh(repo, ['config', 'core.hooksPath', '.husky/_']);

    const plan = planProject(repo, false);
    const files = plan.steps.map((s) => path.relative(repo, s.file));
    expect(files).not.toContain('.claude/settings.local.json');
    expect(files).not.toContain('.codex/config.toml');
    const notes = plan.notes.join('\n');
    expect(notes).toContain('已被 git 跟踪');
    expect(notes).toContain('未被 Codex 信任');
    expect(notes).toContain('core.hooksPath');
  });
});

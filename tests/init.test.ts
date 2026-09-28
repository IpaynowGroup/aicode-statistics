import fs from 'node:fs';
import path from 'node:path';
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

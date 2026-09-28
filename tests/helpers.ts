import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 创建临时 HOME 并切换过去，隔离 ~/.aicode、~/.claude、~/.codex 和 git 全局配置 */
export function tmpHome(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-home-')));
  process.env.HOME = dir;
  delete process.env.AICODE_HOME;
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  return dir;
}

export function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** 创建临时 git 仓库，并配置提交身份（git 2.15 不支持 init -b） */
export function initRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-repo-')));
  sh(dir, ['init', '-q']);
  sh(dir, ['config', 'user.name', 'Tester']);
  sh(dir, ['config', 'user.email', 'tester@example.com']);
  return dir;
}

export function commitAll(repo: string, msg: string): string {
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-q', '-m', msg]);
  return sh(repo, ['rev-parse', 'HEAD']).trim();
}

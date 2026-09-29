import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitCommonDir, tryGit } from '../git.js';
import { gitHooksDir, installStatePath } from '../paths.js';
import { aicodeCommand, shq } from './shell.js';

export const HOOK_NAMES = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'post-rewrite',
  'pre-auto-gc', 'push-to-checkout', 'sendemail-validate', 'reference-transaction',
];
const PROJECT_MARK = '# aicode project post-commit';
// 同步捕获本次 commit 的信息，避免后台统计进程读到晚到的 HEAD/分支（见 F1）
const CAPTURE_LINES = [
  'SHA=$(git rev-parse HEAD 2>/dev/null)',
  'BRANCH=$(git symbolic-ref -q --short HEAD 2>/dev/null || echo HEAD)',
  'REFLOG=$(git reflog -1 --format=%gs 2>/dev/null)',
  'PREV=$(git rev-parse -q --verify HEAD@{1} 2>/dev/null)',
];
const backgroundCommit = (commitCommand: string): string =>
  [...CAPTURE_LINES, `( ${commitCommand} --sha "$SHA" --branch "$BRANCH" --reflog "$REFLOG" --prev "$PREV" </dev/null >/dev/null 2>&1 & )`].join('\n');

// ---------- 全局模式 ----------

interface InstallState { prevHooksPath: string | null }

function readState(): InstallState {
  try {
    return JSON.parse(fs.readFileSync(installStatePath(), 'utf8')) as InstallState;
  } catch {
    return { prevHooksPath: null };
  }
}

function writeState(state: InstallState): void {
  fs.mkdirSync(path.dirname(installStatePath()), { recursive: true });
  fs.writeFileSync(installStatePath(), JSON.stringify(state, null, 2) + '\n');
}

function globalGit(args: string[]): void {
  execFileSync('git', ['config', '--global', ...args], { cwd: os.homedir(), stdio: 'ignore' });
}

function currentGlobalHooksPath(): string | null {
  const v = tryGit(os.homedir(), ['config', '--global', '--get', 'core.hooksPath'])?.trim();
  return v ? v.replace(/^~(?=\/)/, os.homedir()) : null;
}

/**
 * 模拟 git 原有行为：原来设置了全局 hooksPath 就只调用它，否则调用仓库自己的 .git/hooks。
 * 透传原 hook 的退出码；post-commit 额外在后台启动统计，不阻塞 commit。
 */
export function renderForwarder(name: string, prevHooksPath: string | null, commitCommand: string): string {
  const lines = [
    '#!/bin/sh',
    '# 由 aicode 生成：转发到原有 hook',
    `HOOK_NAME=${shq(name)}`,
    `PREV_HOOKS=${shq(prevHooksPath ?? '')}`,
    'if [ -n "$PREV_HOOKS" ]; then TARGET="$PREV_HOOKS/$HOOK_NAME"; else TARGET="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/$HOOK_NAME"; fi',
    'status=0',
    'if [ -x "$TARGET" ]; then "$TARGET" "$@"; status=$?; fi',
  ];
  if (name === 'post-commit') lines.push(backgroundCommit(commitCommand));
  lines.push('exit $status');
  return lines.join('\n') + '\n';
}

export function installGitHooks(): void {
  const dir = gitHooksDir();
  fs.mkdirSync(dir, { recursive: true });
  const current = currentGlobalHooksPath();
  const prev = current && path.resolve(current) !== dir ? current : readState().prevHooksPath;
  writeState({ prevHooksPath: prev });
  const commitCommand = aicodeCommand('commit');
  for (const name of HOOK_NAMES) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, renderForwarder(name, prev, commitCommand));
    fs.chmodSync(file, 0o755);
  }
  globalGit(['core.hooksPath', dir]);
}

export function uninstallGitHooks(): void {
  const current = currentGlobalHooksPath();
  if (current && path.resolve(current) === gitHooksDir()) {
    const { prevHooksPath } = readState();
    if (prevHooksPath) globalGit(['core.hooksPath', prevHooksPath]);
    else globalGit(['--unset', 'core.hooksPath']);
  }
  fs.rmSync(gitHooksDir(), { recursive: true, force: true });
  fs.rmSync(installStatePath(), { force: true });
}

// ---------- 项目模式 ----------

export function projectHookPath(repo: string): string {
  return path.join(gitCommonDir(repo), 'hooks', 'post-commit');
}

export function renderProjectPostCommit(origPath: string, commitCommand: string): string {
  return [
    '#!/bin/sh',
    PROJECT_MARK,
    `ORIG=${shq(origPath)}`,
    'status=0',
    'if [ -x "$ORIG" ]; then "$ORIG" "$@"; status=$?; fi',
    backgroundCommit(commitCommand),
    'exit $status',
  ].join('\n') + '\n';
}

export function isAicodeHook(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes(PROJECT_MARK);
  } catch {
    return false;
  }
}

export function installProjectGitHook(repo: string): void {
  const hook = projectHookPath(repo);
  const orig = hook + '.aicode-orig';
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  if (fs.existsSync(hook) && !isAicodeHook(hook)) {
    if (fs.existsSync(orig)) {
      // hook 已被其他工具替换，且已有一份旧备份：直接覆盖会连同对方的 hook 一起丢失，改为中止让用户手动处理
      throw new Error('post-commit 已被其他工具替换，且存在旧的 post-commit.aicode-orig，请先手动处理');
    }
    fs.renameSync(hook, orig);
  }
  fs.writeFileSync(hook, renderProjectPostCommit(orig, aicodeCommand('commit')));
  fs.chmodSync(hook, 0o755);
}

export function uninstallProjectGitHook(repo: string): void {
  const hook = projectHookPath(repo);
  const orig = hook + '.aicode-orig';
  if (isAicodeHook(hook)) fs.unlinkSync(hook);
  // 只有 post-commit 已不存在（即上一步确实是 aicode 的 hook）才恢复备份；
  // 如果 hook 已被其他工具替换，恢复备份会覆盖对方的 hook，保留两者交由用户手动处理
  if (fs.existsSync(orig) && !fs.existsSync(hook)) fs.renameSync(orig, hook);
}

import fs from 'node:fs';
import path from 'node:path';
import { writeDefaultConfig } from './config.js';
import { isTracked, localHooksPath, repoRoot } from './git.js';
import { installClaude, uninstallClaude } from './installer/claude.js';
import { installCodex, installProjectCodex, isCodexTrusted, uninstallCodex, uninstallProjectCodex } from './installer/codex.js';
import { addExclude, removeExclude } from './installer/exclude.js';
import {
  installGitHooks, installProjectGitHook, isAicodeHook, projectHookPath, uninstallGitHooks, uninstallProjectGitHook,
} from './installer/git.js';
import { aicodeHome, claudeSettingsPath, codexHome, configPath, ledgerDir, logPath, pendingDir } from './paths.js';

export interface Step { file: string; summary: string; apply: () => void }
export interface Plan { steps: Step[]; notes: string[] }

const PROJECT_CLAUDE = '.claude/settings.local.json';
const PROJECT_CODEX = '.codex/config.toml';
const HUSKY_NOTE = (p: string) => `该仓库设置了仓库级 core.hooksPath=${p}（如 husky），git 不会调用 aicode 的 post-commit，commit 统计不会触发`;

function homeStep(): Step {
  return {
    file: configPath(),
    summary: '创建 ~/.aicode 目录结构；配置文件不存在时写入默认配置；把配置文件权限设为 600',
    apply: () => {
      for (const dir of [aicodeHome(), ledgerDir(), pendingDir(), path.dirname(logPath())]) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(configPath())) writeDefaultConfig();
      fs.chmodSync(configPath(), 0o600); // 可能包含数据库密码，仅本人可读写
    },
  };
}

export function planGlobal(uninstall: boolean): Plan {
  const steps: Step[] = [];
  const notes: string[] = [];
  const codexConfig = path.join(codexHome(), 'config.toml');
  const hasCodex = fs.existsSync(codexHome());
  if (!uninstall) steps.push(homeStep());
  steps.push({
    file: claudeSettingsPath(),
    summary: uninstall ? '移除 aicode 的 PreToolUse/PostToolUse 钩子' : '合并 PreToolUse/PostToolUse 钩子（已存在的文件先备份为 .aicode.bak）',
    apply: () => (uninstall ? uninstallClaude(claudeSettingsPath()) : installClaude(claudeSettingsPath())),
  });
  if (hasCodex) {
    steps.push({
      file: codexConfig,
      summary: uninstall ? '移除 aicode 钩子区块与 features 标记行' : '开启 [features].hooks，追加钩子与信任记录（先备份为 .aicode.bak）',
      apply: () => (uninstall ? uninstallCodex(codexConfig) : installCodex(codexConfig)),
    });
  } else {
    notes.push('未检测到 Codex（~/.codex 不存在），已跳过');
  }
  steps.push({
    file: '~/.gitconfig（core.hooksPath）',
    summary: uninstall ? '恢复原来的全局 core.hooksPath，删除转发脚本' : '设置全局 core.hooksPath=~/.aicode/git-hooks，并生成转发到原有 hook 的脚本',
    apply: () => (uninstall ? uninstallGitHooks() : installGitHooks()),
  });
  if (!uninstall) notes.push('仓库级设置了 core.hooksPath 的仓库（如 husky）不会触发 commit 统计');
  return { steps, notes };
}

export function planProject(cwd: string, uninstall: boolean): Plan {
  const root = repoRoot(cwd);
  if (!root) throw new Error('当前目录不在 git 仓库中');
  const steps: Step[] = [];
  const notes: string[] = [];
  const claudeFile = path.join(root, PROJECT_CLAUDE);
  const codexFile = path.join(root, PROJECT_CODEX);
  const excludeFile = path.join(root, '.git', 'info', 'exclude');
  const hookFile = projectHookPath(root);

  if (uninstall) {
    if (isTracked(root, PROJECT_CLAUDE)) {
      notes.push(`${PROJECT_CLAUDE} 已被 git 跟踪，未被 aicode 修改过，已跳过`);
    } else {
      steps.push({ file: claudeFile, summary: '移除 aicode 钩子', apply: () => uninstallClaude(claudeFile) });
    }
    if (isTracked(root, PROJECT_CODEX)) {
      notes.push(`${PROJECT_CODEX} 已被 git 跟踪，未被 aicode 修改过，已跳过`);
    } else {
      steps.push({ file: codexFile, summary: '移除 aicode 钩子区块，并删除 ~/.codex/config.toml 中该项目的信任区块', apply: () => uninstallProjectCodex(codexFile) });
    }
    steps.push({ file: excludeFile, summary: '移除 aicode 写入的忽略条目', apply: () => removeExclude(root) });
    if (fs.existsSync(hookFile) && !isAicodeHook(hookFile) && fs.existsSync(hookFile + '.aicode-orig')) {
      notes.push('post-commit 已被其他工具替换，无法安全恢复 aicode 安装前的 hook，将保留两者，请手动处理 post-commit.aicode-orig');
    }
    steps.push({ file: hookFile, summary: '删除 aicode 的 post-commit，恢复原有 hook', apply: () => uninstallProjectGitHook(root) });
    return { steps, notes };
  }

  steps.push(homeStep());
  const excludes: string[] = [];
  if (isTracked(root, PROJECT_CLAUDE)) {
    notes.push(`${PROJECT_CLAUDE} 已被 git 跟踪，为避免改动团队共享配置已跳过 Claude Code；可改用全局模式`);
  } else {
    steps.push({ file: claudeFile, summary: '合并 PreToolUse/PostToolUse 钩子', apply: () => installClaude(claudeFile) });
    excludes.push(`/${PROJECT_CLAUDE}`, `/${PROJECT_CLAUDE}.aicode.bak`);
  }
  if (isTracked(root, PROJECT_CODEX)) {
    notes.push(`${PROJECT_CODEX} 已被 git 跟踪，已跳过 Codex；可改用全局模式`);
  } else if (!isCodexTrusted(root)) {
    notes.push('该项目未被 Codex 信任（~/.codex/config.toml 中没有 trust_level = "trusted"），Codex 不会加载项目级配置，已跳过 Codex');
  } else {
    steps.push({
      file: codexFile,
      summary: '写入项目钩子；并在全局 ~/.codex/config.toml 追加该项目的信任区块（Codex 只认全局文件中的信任记录；先备份为 .aicode.bak，卸载时删除该区块）',
      apply: () => installProjectCodex(codexFile),
    });
    excludes.push(`/${PROJECT_CODEX}`, `/${PROJECT_CODEX}.aicode.bak`);
  }
  if (excludes.length) {
    steps.push({ file: excludeFile, summary: `追加忽略条目 ${excludes.join(' ')}，避免出现在 git status 中`, apply: () => addExclude(root, excludes) });
  }
  steps.push({ file: hookFile, summary: '写入 post-commit；已有的 hook 改名为 post-commit.aicode-orig 并在其中被调用', apply: () => installProjectGitHook(root) });
  const local = localHooksPath(root);
  if (local) notes.push(HUSKY_NOTE(local));
  return { steps, notes };
}

#!/usr/bin/env node
import readline from 'node:readline';
import { runCommit } from './commit.js';
import { repoRoot } from './git.js';
import { runHook } from './hook.js';
import { planGlobal, planProject } from './init.js';
import { logError } from './log.js';
import { describeTrack, setTrackAll, trackRepo, untrackRepo } from './track.js';

const USAGE = [
  '用法:',
  '  aicode init [--local] [--uninstall] [--yes]     安装 / 卸载钩子（--local 仅作用于当前仓库）',
  '  aicode hook <pre|post> --tool <claude|codex>    由 AI 工具钩子调用',
  '  aicode commit                                   由 post-commit 调用',
  '  aicode track [--all|--list]                     把当前仓库加入统计名单 / 恢复统计所有仓库 / 查看名单',
  '  aicode untrack                                  把当前仓库移出统计名单',
].join('\n');

/** 解析 `--name value` 形式的参数；未传或值为空字符串时视为缺省 */
function parseFlags(args: string[], names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const i = args.indexOf(`--${name}`);
    if (i !== -1 && args[i + 1] !== undefined && args[i + 1] !== '') out[name] = args[i + 1];
  }
  return out;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function init(flags: string[]): Promise<number> {
  const allowedFlags = new Set(['--local', '--uninstall', '--yes']);
  for (const flag of flags) {
    if (!allowedFlags.has(flag)) {
      console.error(`未知参数: ${flag}`);
      console.error(USAGE);
      return 1;
    }
  }
  const uninstall = flags.includes('--uninstall');
  const plan = flags.includes('--local') ? planProject(process.cwd(), uninstall) : planGlobal(uninstall);
  console.log(uninstall ? '将执行以下卸载操作：' : '将执行以下改动：');
  for (const s of plan.steps) console.log(`  - ${s.file}\n      ${s.summary}`);
  for (const n of plan.notes) console.log(`  ! ${n}`);
  if (!flags.includes('--yes')) {
    if (!process.stdin.isTTY) {
      console.error('非交互环境下请加 --yes 确认执行');
      return 1;
    }
    if (!(await confirm('确认执行？[y/N] '))) {
      console.log('已取消，未做任何改动');
      return 0;
    }
  }
  for (const s of plan.steps) s.apply();
  console.log('完成');
  return 0;
}

function track(flags: string[]): number {
  const allowedFlags = new Set(['--all', '--list']);
  for (const flag of flags) {
    if (!allowedFlags.has(flag)) {
      console.error(`未知参数: ${flag}`);
      console.error(USAGE);
      return 1;
    }
  }
  if (flags.includes('--list')) {
    console.log(describeTrack());
    return 0;
  }
  if (flags.includes('--all')) {
    setTrackAll();
    console.log('已恢复统计所有仓库');
    return 0;
  }
  const root = repoRoot(process.cwd());
  if (!root) {
    console.error('当前目录不在 git 仓库中');
    return 1;
  }
  const { id, switched } = trackRepo(root);
  console.log(`已加入统计名单：${id}`);
  if (switched) console.log('现在只统计名单中的仓库（aicode track --all 可恢复统计全部）');
  return 0;
}

function untrack(flags: string[]): number {
  if (flags.length) {
    console.error(`未知参数: ${flags[0]}`);
    console.error(USAGE);
    return 1;
  }
  const root = repoRoot(process.cwd());
  if (!root) {
    console.error('当前目录不在 git 仓库中');
    return 1;
  }
  const { id, removed } = untrackRepo(root);
  console.log(removed ? `已移出统计名单：${id}` : '该仓库不在名单中');
  return 0;
}

async function main(args: string[]): Promise<number> {
  const [cmd, ...rest] = args;
  if (cmd === 'init') {
    try {
      return await init(rest);
    } catch (err) {
      console.error(`aicode init 失败: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (cmd === 'track') {
    try {
      return track(rest);
    } catch (err) {
      console.error(`aicode track 失败: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (cmd === 'untrack') {
    try {
      return untrack(rest);
    } catch (err) {
      console.error(`aicode untrack 失败: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  // hook / commit：任何异常只记日志，退出码恒为 0，绝不阻塞 AI 工具或 git
  try {
    if (cmd === 'hook') {
      const phase = rest[0];
      const tool = rest[rest.indexOf('--tool') + 1];
      if ((phase === 'pre' || phase === 'post') && (tool === 'claude' || tool === 'codex')) {
        const text = await readStdin();
        runHook(phase, tool, text ? JSON.parse(text) : {});
      }
      return 0;
    }
    if (cmd === 'commit') {
      const opts = parseFlags(rest, ['sha', 'branch', 'reflog', 'prev']);
      await runCommit(process.cwd(), opts);
      return 0;
    }
  } catch (err) {
    logError(cmd ?? 'cli', err);
    return 0;
  }
  console.log(USAGE);
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code));

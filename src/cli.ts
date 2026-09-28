#!/usr/bin/env node
import readline from 'node:readline';
import { runCommit } from './commit.js';
import { runHook } from './hook.js';
import { planGlobal, planProject } from './init.js';
import { logError } from './log.js';

const USAGE = [
  '用法:',
  '  aicode init [--project] [--uninstall] [--yes]   安装 / 卸载钩子（--project 仅作用于当前仓库）',
  '  aicode hook <pre|post> --tool <claude|codex>    由 AI 工具钩子调用',
  '  aicode commit                                   由 post-commit 调用',
].join('\n');

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
  const uninstall = flags.includes('--uninstall');
  const plan = flags.includes('--project') ? planProject(process.cwd(), uninstall) : planGlobal(uninstall);
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
      await runCommit(process.cwd());
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

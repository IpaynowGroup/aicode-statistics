import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fingerprintText } from '../src/fingerprint.js';
import { repoId, repoKey } from '../src/git.js';
import { runHook } from '../src/hook.js';
import { readRecords } from '../src/ledger.js';
import { pendingDir } from '../src/paths.js';
import { commitAll, initRepo, tmpHome } from './helpers.js';

let home: string;
beforeEach(() => {
  home = tmpHome();
});
const records = (repo: string) => readRecords(repoKey(repoId(repo)));

describe('Claude 编辑类工具', () => {
  it('pre/post 对比后只记录新增行，并从 transcript 读取模型', () => {
    const repo = initRepo();
    const file = path.join(repo, 'a.ts');
    fs.writeFileSync(file, 'old line\n');
    commitAll(repo, 'init');
    const transcript = path.join(home, 't.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } }) + '\n');
    const raw = { session_id: 's1', tool_use_id: 't1', cwd: repo, tool_name: 'Edit', tool_input: { file_path: file, new_string: 'ignored' }, transcript_path: transcript };
    runHook('pre', 'claude', raw);
    fs.writeFileSync(file, 'old line\nnew line 1\nnew line 2\n');
    runHook('post', 'claude', raw);
    const recs = records(repo);
    expect(recs.map((r) => r.f)).toEqual(fingerprintText('new line 1\nnew line 2'));
    expect(recs[0]).toMatchObject({ p: 'a.ts', t: 'claude-code', m: 'claude-opus-5-5', s: 's1' });
    expect(fs.readdirSync(pendingDir()).every((n) => n.endsWith('.done'))).toBe(true);
  });

  it('同一次调用触发两遍钩子（全局 + 项目模式）时只记录一次', () => {
    const repo = initRepo();
    const file = path.join(repo, 'd.ts');
    const raw = { session_id: 's', tool_use_id: 'dup', cwd: repo, tool_name: 'Write', tool_input: { file_path: file, content: 'x\ny\n' } };
    runHook('pre', 'claude', raw);
    runHook('pre', 'claude', raw);
    fs.writeFileSync(file, 'x\ny\n');
    runHook('post', 'claude', raw);
    runHook('post', 'claude', raw);
    expect(records(repo).map((r) => r.f)).toEqual(fingerprintText('x\ny'));
  });

  it('没有 pre 基线时退回使用 tool_input 文本', () => {
    const repo = initRepo();
    const file = path.join(repo, 'b.ts');
    fs.writeFileSync(file, 'x\ny\n');
    runHook('post', 'claude', { session_id: 's', tool_use_id: 't', cwd: repo, tool_name: 'Write', tool_input: { file_path: file, content: 'x\ny\n' } });
    expect(records(repo).map((r) => r.f)).toEqual(fingerprintText('x\ny'));
  });

  it('被忽略的文件不记录', () => {
    const repo = initRepo();
    const file = path.join(repo, 'yarn.lock');
    const raw = { session_id: 's', tool_use_id: 't', cwd: repo, tool_name: 'Write', tool_input: { file_path: file, content: 'a' } };
    runHook('pre', 'claude', raw);
    fs.writeFileSync(file, 'a\n');
    runHook('post', 'claude', raw);
    expect(records(repo)).toEqual([]);
  });

  it('跳过 Read 等无关工具，不产生 pending', () => {
    const repo = initRepo();
    runHook('pre', 'claude', { session_id: 's', tool_use_id: 't', cwd: repo, tool_name: 'Read', tool_input: { file_path: path.join(repo, 'a') } });
    expect(fs.existsSync(pendingDir())).toBe(false);
  });
});

describe('shell 类工具', () => {
  it('Claude Bash：排除执行前的人工改动', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.ts'), 'base\n');
    commitAll(repo, 'init');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'base\nhuman\n');
    const raw = { session_id: 's', tool_use_id: 'b1', cwd: repo, tool_name: 'Bash', tool_input: { command: 'x' } };
    runHook('pre', 'claude', raw);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'base\nhuman\nfrom ai\n');
    runHook('post', 'claude', raw);
    expect(records(repo).map((r) => r.f)).toEqual(fingerprintText('from ai'));
  });

  it('Codex exec：使用钩子输入中的 model', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'seed.txt'), 's\n');
    commitAll(repo, 'init');
    const raw = { session_id: 'c1', tool_use_id: 'x1', cwd: repo, tool_name: 'exec', model: 'gpt-5.6-luna' };
    runHook('pre', 'codex', raw);
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'n.ts'), 'codex line\n');
    runHook('post', 'codex', raw);
    expect(records(repo)).toEqual([expect.objectContaining({ p: 'src/n.ts', t: 'codex', m: 'gpt-5.6-luna', s: 'c1' })]);
  });

  it('不在 git 仓库中时不做任何事', () => {
    const raw = { session_id: 's', tool_use_id: 't', cwd: home, tool_name: 'Bash' };
    runHook('pre', 'claude', raw);
    runHook('post', 'claude', raw);
    expect(fs.existsSync(pendingDir())).toBe(false);
  });
});

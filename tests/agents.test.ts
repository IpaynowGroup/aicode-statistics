import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { classifyClaudeTool, claudeModelFromTranscript, parseClaudeHook } from '../src/agents/claude.js';
import { classifyCodexTool, codexModelFromRollout, findCodexRollout, parseCodexHook } from '../src/agents/codex.js';
import { tmpHome } from './helpers.js';

describe('Claude', () => {
  beforeEach(() => tmpHome());

  it('按工具名分类', () => {
    expect(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].map(classifyClaudeTool)).toEqual(['edit', 'edit', 'edit', 'edit']);
    expect(classifyClaudeTool('Bash')).toBe('shell');
    expect(classifyClaudeTool('Read')).toBe('skip');
  });

  it('解析 Edit / MultiEdit / Write 的输入', () => {
    const base = { session_id: 's1', tool_use_id: 't1', cwd: '/repo', transcript_path: '/t.jsonl' };
    expect(parseClaudeHook({ ...base, tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', new_string: 'x' } })).toEqual({
      agent: 'claude-code', toolClass: 'edit', sessionId: 's1', toolUseId: 't1', cwd: '/repo',
      filePath: '/repo/src/a.ts', fallbackText: 'x', transcriptPath: '/t.jsonl', model: null,
    });
    expect(parseClaudeHook({ ...base, tool_name: 'MultiEdit', tool_input: { file_path: '/abs/a.ts', edits: [{ new_string: 'a' }, { new_string: 'b' }] } }).fallbackText).toBe('a\nb');
    expect(parseClaudeHook({ ...base, tool_name: 'Write', tool_input: { file_path: '/abs/a.ts', content: 'c' } }).fallbackText).toBe('c');
    expect(parseClaudeHook({}).sessionId).toBe('unknown');
  });

  it('从 transcript 末尾读取最近一次 assistant 使用的模型', () => {
    const file = path.join(process.env.HOME!, 't.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'assistant', message: { model: 'old-model' } }),
      JSON.stringify({ type: 'user', message: {} }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } }),
      '',
    ].join('\n'));
    expect(claudeModelFromTranscript(file)).toBe('claude-opus-5-5');
    expect(claudeModelFromTranscript('/nope.jsonl')).toBeNull();
  });
});

describe('Codex', () => {
  beforeEach(() => tmpHome());

  it('按工具名分类，并去掉 functions. 前缀', () => {
    expect(['apply_patch', 'exec_command', 'shell', 'shell_command', 'Bash', 'exec', 'functions.exec_command', 'multi_tool_use.parallel'].map(classifyCodexTool))
      .toEqual(Array(8).fill('shell'));
    expect(classifyCodexTool('web_search')).toBe('skip');
  });

  it('解析输入，session_id 缺失时用 thread_id', () => {
    const input = parseCodexHook({ thread_id: 'th1', tool_name: 'exec', cwd: '/repo', model: 'gpt-x' });
    expect(input).toMatchObject({ agent: 'codex', toolClass: 'shell', sessionId: 'th1', toolUseId: 'unknown', model: 'gpt-x', filePath: null });
  });

  it('按 session_id 查找会话日志，并从中读取最近的 turn_context 模型', () => {
    const dir = path.join(process.env.HOME!, '.codex', 'sessions', '2026', '09', '24');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-2026-09-24T10-00-00-abc-123.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'abc-123' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-a' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-b' } }),
      '',
    ].join('\n'));
    expect(findCodexRollout('abc-123')).toBe(file);
    expect(findCodexRollout('zzz')).toBeNull();
    expect(codexModelFromRollout(file)).toBe('gpt-b');
  });
});

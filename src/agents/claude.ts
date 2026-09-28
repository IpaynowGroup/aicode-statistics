import path from 'node:path';
import { readTail, type HookInput, type ToolClass } from './types.js';

export function classifyClaudeTool(name: string): ToolClass {
  switch (name.toLowerCase()) {
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
      return 'edit';
    case 'bash':
      return 'shell';
    default:
      return 'skip';
  }
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function fallbackText(input: Obj): string | null {
  if (typeof input.content === 'string') return input.content;
  if (typeof input.new_string === 'string') return input.new_string;
  if (typeof input.new_source === 'string') return input.new_source;
  if (Array.isArray(input.edits)) return input.edits.map((e) => str((e as Obj)?.new_string) ?? '').join('\n');
  return null;
}

export function parseClaudeHook(raw: unknown): HookInput {
  const data = (raw ?? {}) as Obj;
  const toolInput = (data.tool_input ?? {}) as Obj;
  const cwd = str(data.cwd) ?? process.cwd();
  const file = str(toolInput.file_path) ?? str(toolInput.notebook_path);
  return {
    agent: 'claude-code',
    toolClass: classifyClaudeTool(str(data.tool_name) ?? ''),
    sessionId: str(data.session_id) ?? 'unknown',
    toolUseId: str(data.tool_use_id) ?? 'unknown',
    cwd,
    filePath: file ? path.resolve(cwd, file) : null,
    fallbackText: fallbackText(toolInput),
    transcriptPath: str(data.transcript_path),
    model: null,
  };
}

export function claudeModelFromTranscript(file: string): string | null {
  try {
    const lines = readTail(file, 64 * 1024).split('\n').reverse();
    for (const line of lines) {
      try {
        const o = JSON.parse(line) as { type?: string; message?: { model?: unknown } };
        if (o.type === 'assistant' && typeof o.message?.model === 'string') return o.message.model;
      } catch {
        // 首行可能被截断
      }
    }
  } catch {
    // 文件不存在
  }
  return null;
}

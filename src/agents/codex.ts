import fs from 'node:fs';
import path from 'node:path';
import { codexHome } from '../paths.js';
import { readTail, type HookInput, type ToolClass } from './types.js';

// Codex 的 apply_patch 也按 shell 快照处理，无需解析补丁格式
const SHELL_TOOLS = new Set(['apply_patch', 'exec_command', 'shell', 'shell_command', 'Bash', 'exec', 'multi_tool_use.parallel']);

export function classifyCodexTool(name: string): ToolClass {
  return SHELL_TOOLS.has(name.replace(/^functions\./, '')) ? 'shell' : 'skip';
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function parseCodexHook(raw: unknown): HookInput {
  const data = (raw ?? {}) as Obj;
  return {
    agent: 'codex',
    toolClass: classifyCodexTool(str(data.tool_name) ?? ''),
    sessionId: str(data.session_id) ?? str(data.thread_id) ?? 'unknown',
    toolUseId: str(data.tool_use_id) ?? 'unknown',
    cwd: str(data.cwd) ?? process.cwd(),
    filePath: null,
    fallbackText: null,
    transcriptPath: str(data.transcript_path),
    model: str(data.model),
  };
}

/** 在 sessions/YYYY/MM/DD 下按日期倒序查找 rollout-*-<sessionId>.jsonl */
export function findCodexRollout(sessionId: string): string | null {
  const root = path.join(codexHome(), 'sessions');
  const desc = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  const suffix = `-${sessionId}.jsonl`;
  for (const y of desc(root)) {
    for (const m of desc(path.join(root, y))) {
      for (const d of desc(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        const hit = desc(dir).find((f) => f.endsWith(suffix));
        if (hit) return path.join(dir, hit);
      }
    }
  }
  return null;
}

/** 模型名在 turn_context.payload.model，取日志末尾最近的一条 */
export function codexModelFromRollout(file: string): string | null {
  try {
    const lines = readTail(file, 256 * 1024).split('\n').reverse();
    for (const line of lines) {
      try {
        const o = JSON.parse(line) as { type?: string; payload?: { model?: unknown } };
        if (o.type === 'turn_context' && typeof o.payload?.model === 'string') return o.payload.model;
      } catch {
        // 首行可能被截断
      }
    }
  } catch {
    // 文件不存在
  }
  return null;
}

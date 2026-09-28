import fs from 'node:fs';

export type Phase = 'pre' | 'post';
export type ToolClass = 'edit' | 'shell' | 'skip';
export type AgentName = 'claude-code' | 'codex';

export interface HookInput {
  agent: AgentName;
  toolClass: ToolClass;
  sessionId: string;
  toolUseId: string;
  cwd: string;
  filePath: string | null; // 编辑类工具的目标文件（绝对路径）
  fallbackText: string | null; // 缺少 pre 基线时，退回使用的新写入文本
  transcriptPath: string | null;
  model: string | null;
}

export function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

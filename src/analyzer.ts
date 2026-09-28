import { fingerprintLines } from './fingerprint.js';
import type { FileDiff } from './git.js';
import type { IgnoreFn } from './ignore.js';
import type { LedgerRecord } from './ledger.js';

export interface FileStat { path: string; module: string; added: number; ai: number }
export interface ToolStat { ai: number; generated: number }
export interface CommitStats {
  added_total: number;
  added_ai: number;
  added_human: number;
  deleted_total: number;
  ai_ratio: number;
  ai_generated: number;
  ai_accept_rate: number;
  by_tool: Record<string, ToolStat>;
}
export interface AnalyzeResult { stats: CommitStats; files: FileStat[]; remaining: LedgerRecord[] }

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const toolKey = (r: LedgerRecord): string => `${r.t}/${r.m}`;

export function analyzeCommit(
  diffs: FileDiff[],
  records: LedgerRecord[],
  isIgnored: IgnoreFn,
  moduleOf: (path: string) => string,
): AnalyzeResult {
  const byTool: Record<string, ToolStat> = {};
  const tool = (key: string): ToolStat => (byTool[key] ??= { ai: 0, generated: 0 });
  const counted = diffs.filter((d) => !d.binary && !isIgnored(d.path));

  // 生成量：本次涉及文件（含重命名前路径）在 ledger 中的全部记录
  const touched = new Set(counted.flatMap((d) => (d.oldPath ? [d.path, d.oldPath] : [d.path])));
  let generated = 0;
  for (const r of records) {
    if (touched.has(r.p)) {
      generated++;
      tool(toolKey(r)).generated++;
    }
  }

  // 可消费池：路径+指纹 → 记录下标队列（先写入的先消费）
  const pool = new Map<string, number[]>();
  records.forEach((r, i) => {
    const k = `${r.p}\0${r.f}`;
    const q = pool.get(k);
    if (q) q.push(i);
    else pool.set(k, [i]);
  });
  const take = (p: string, f: string): number | undefined => pool.get(`${p}\0${f}`)?.shift();

  const consumed = new Set<number>();
  const files: FileStat[] = [];
  let addedTotal = 0;
  let addedAi = 0;
  let deletedTotal = 0;
  for (const d of counted) {
    const fps = fingerprintLines(d.added);
    let ai = 0;
    for (const f of fps) {
      const idx = take(d.path, f) ?? (d.oldPath ? take(d.oldPath, f) : undefined);
      if (idx === undefined) continue;
      consumed.add(idx);
      ai++;
      tool(toolKey(records[idx])).ai++;
    }
    files.push({ path: d.path, module: moduleOf(d.path), added: fps.length, ai });
    addedTotal += fps.length;
    addedAi += ai;
    deletedTotal += d.deleted;
  }

  return {
    stats: {
      added_total: addedTotal,
      added_ai: addedAi,
      added_human: addedTotal - addedAi,
      deleted_total: deletedTotal,
      ai_ratio: addedTotal ? round3(addedAi / addedTotal) : 0,
      ai_generated: generated,
      ai_accept_rate: generated ? round3(addedAi / generated) : 0,
      by_tool: byTool,
    },
    files,
    remaining: records.filter((_, i) => !consumed.has(i)),
  };
}

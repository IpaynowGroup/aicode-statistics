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
export interface AnalyzeResult { stats: CommitStats; files: FileStat[]; records: LedgerRecord[] }

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const toolKey = (r: LedgerRecord): string => `${r.t}/${r.m}`;

/**
 * @param sha 本次 commit 的 sha，被消费的记录会标记 c=sha（不再删除，交给调用方按 TTL 清理）
 * @param reusableSha amend 场景下被替换掉的旧 commit sha；其名下已消费的记录会被临时借回可消费池，
 *   重新匹配上则记为新 sha，没匹配上则放回未消费状态（见 F3）
 */
export function analyzeCommit(
  diffs: FileDiff[],
  records: LedgerRecord[],
  isIgnored: IgnoreFn,
  moduleOf: (path: string) => string,
  sha: string,
  reusableSha?: string,
): AnalyzeResult {
  const byTool: Record<string, ToolStat> = {};
  const tool = (key: string): ToolStat => (byTool[key] ??= { ai: 0, generated: 0 });
  const counted = diffs.filter((d) => !d.binary && !isIgnored(d.path));
  const eligible = (r: LedgerRecord): boolean => r.c === undefined || r.c === reusableSha;

  // 生成量：本次涉及文件（含重命名前路径）在 ledger 中尚未被其他 commit 消费的记录
  const touched = new Set(counted.flatMap((d) => (d.oldPath ? [d.path, d.oldPath] : [d.path])));
  let generated = 0;
  for (const r of records) {
    if (touched.has(r.p) && eligible(r)) {
      generated++;
      tool(toolKey(r)).generated++;
    }
  }

  // 可消费池：路径+指纹 → 记录下标队列（先写入的先消费），只含尚未被其他 commit 消费的记录
  const pool = new Map<string, number[]>();
  records.forEach((r, i) => {
    if (!eligible(r)) return;
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

  // 本次消费的记录标记归属该 commit；amend 时被临时借用但这次没有再匹配上的记录放回未消费状态
  const updated = records.map((r, i) => {
    if (consumed.has(i)) return { ...r, c: sha };
    if (reusableSha !== undefined && r.c === reusableSha) return { ...r, c: undefined };
    return r;
  });

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
    records: updated,
  };
}

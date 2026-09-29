import { claudeModelFromTranscript, parseClaudeHook } from './agents/claude.js';
import { codexModelFromRollout, findCodexRollout, parseCodexHook } from './agents/codex.js';
import type { HookInput, Phase } from './agents/types.js';
import { loadConfig } from './config.js';
import { fingerprintText } from './fingerprint.js';
import { repoId, repoKey, repoRoot, repoRootForPath, toRepoRelative } from './git.js';
import { buildIgnore, type IgnoreFn } from './ignore.js';
import { appendRecords, type LedgerRecord } from './ledger.js';
import {
  captureEditBaseline, captureShellBaseline, cleanupPending, editChanges, hasPending, isDone, savePending, shellChanges,
  takePending, type Baseline, type Change,
} from './snapshot.js';
import { isRepoTracked } from './track.js';

export const HOOK_BUDGET_MS = 2000;

export function runHook(phase: Phase, agent: 'claude' | 'codex', raw: unknown): void {
  const input = agent === 'claude' ? parseClaudeHook(raw) : parseCodexHook(raw);
  if (input.toolClass === 'skip') return;
  const deadline = Date.now() + HOOK_BUDGET_MS;
  const key = `${input.agent}_${input.sessionId}_${input.toolUseId}`;
  // 全局与项目模式同时安装时，同一次调用会触发两遍钩子；tool_use_id 未知时无法区分调用，不去重
  const dedupe = input.toolUseId !== 'unknown';

  if (phase === 'pre') {
    cleanupPending();
    if (dedupe && (hasPending(key) || isDone(key))) return;
    const baseline = input.toolClass === 'edit' ? editBaseline(input) : shellBaseline(input, deadline);
    if (baseline) savePending(key, baseline);
    return;
  }

  if (dedupe && isDone(key)) return;
  const baseline = takePending(key);
  const changes = input.toolClass === 'edit' ? editPost(input, baseline) : shellPost(baseline, deadline);
  if (changes.length) record(input, changes);
}

function ignoreFor(root: string): IgnoreFn {
  return buildIgnore(root, loadConfig(root).ignore);
}

function locate(absPath: string): { root: string; rel: string } | null {
  const root = repoRootForPath(absPath);
  if (!root || !isRepoTracked(root)) return null;
  const rel = toRepoRelative(root, absPath);
  if (rel.startsWith('..') || ignoreFor(root)(rel)) return null;
  return { root, rel };
}

function editBaseline(input: HookInput): Baseline | null {
  const loc = input.filePath ? locate(input.filePath) : null;
  return loc ? captureEditBaseline(loc.root, loc.rel) : null;
}

function shellBaseline(input: HookInput, deadline: number): Baseline | null {
  const root = repoRoot(input.cwd);
  return root && isRepoTracked(root) ? captureShellBaseline(root, ignoreFor(root), deadline) : null;
}

function editPost(input: HookInput, baseline: Baseline | null): Change[] {
  if (baseline?.kind === 'edit') return editChanges(baseline);
  // 基线丢失（pre 失败或未触发）：退回使用工具参数中的新文本
  if (!input.filePath || input.fallbackText === null) return [];
  const loc = locate(input.filePath);
  return loc ? [{ repoRoot: loc.root, rel: loc.rel, fps: fingerprintText(input.fallbackText) }] : [];
}

function shellPost(baseline: Baseline | null, deadline: number): Change[] {
  if (baseline?.kind !== 'shell') return [];
  return shellChanges(baseline, ignoreFor(baseline.repoRoot), deadline);
}

function resolveModel(input: HookInput): string {
  if (input.model) return input.model;
  if (input.agent === 'claude-code') {
    return (input.transcriptPath && claudeModelFromTranscript(input.transcriptPath)) || 'unknown';
  }
  const rollout = input.transcriptPath ?? findCodexRollout(input.sessionId);
  return (rollout && codexModelFromRollout(rollout)) || 'unknown';
}

function record(input: HookInput, changes: Change[]): void {
  const model = resolveModel(input);
  const ts = Math.floor(Date.now() / 1000);
  const byRepo = new Map<string, LedgerRecord[]>();
  for (const c of changes) {
    const list = byRepo.get(c.repoRoot) ?? [];
    for (const f of c.fps) list.push({ p: c.rel, f, t: input.agent, m: model, s: input.sessionId, ts });
    byRepo.set(c.repoRoot, list);
  }
  for (const [root, recs] of byRepo) appendRecords(repoKey(repoId(root)), recs);
}

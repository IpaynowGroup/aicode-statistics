import fs from 'node:fs';
import path from 'node:path';
import { fingerprintText, multisetDiff } from './fingerprint.js';
import { showFile, statusPaths } from './git.js';
import type { IgnoreFn } from './ignore.js';
import { pendingDir } from './paths.js';

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_STATUS_FILES = 50_000;

export interface FileState { mtimeMs: number; size: number; fps: string[] | null }
export type EditBaseline = { kind: 'edit'; repoRoot: string; rel: string; fps: string[] };
export type ShellBaseline = { kind: 'shell'; repoRoot: string; files: Record<string, FileState> };
export type Baseline = EditBaseline | ShellBaseline;
export interface Change { repoRoot: string; rel: string; fps: string[] }

export class BudgetExceeded extends Error {}

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new BudgetExceeded('钩子超出时间预算');
}

/** 供传给 git()/statusPaths() 等的 timeoutMs：始终 >=1，deadline 已过时也不会传 0/负数 */
function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

/** git 子进程被 execFileSync 的 timeout 杀掉时会抛 ETIMEDOUT；统一转成 BudgetExceeded，绝不让钩子卡死 */
function runWithDeadline<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw new BudgetExceeded('钩子超出时间预算');
    throw err;
  }
}

/** 文件不存在返回 []；过大、二进制或不可读返回 null */
export function readFingerprints(absPath: string): string[] | null {
  let buf: Buffer;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    buf = fs.readFileSync(absPath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  if (buf.subarray(0, 8000).includes(0)) return null;
  return fingerprintText(buf.toString('utf8'));
}

function statFile(abs: string): fs.Stats | null {
  try {
    const st = fs.lstatSync(abs);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

export function captureEditBaseline(repoRoot: string, rel: string): EditBaseline | null {
  const fps = readFingerprints(path.join(repoRoot, rel));
  return fps ? { kind: 'edit', repoRoot, rel, fps } : null;
}

export function editChanges(b: EditBaseline): Change[] {
  const after = readFingerprints(path.join(b.repoRoot, b.rel));
  if (!after) return [];
  const fps = multisetDiff(after, b.fps);
  return fps.length ? [{ repoRoot: b.repoRoot, rel: b.rel, fps }] : [];
}

export function captureShellBaseline(repoRoot: string, isIgnored: IgnoreFn, deadline: number): ShellBaseline | null {
  const paths = runWithDeadline(() => statusPaths(repoRoot, remainingMs(deadline)));
  if (paths.length > MAX_STATUS_FILES) return null;
  const files: Record<string, FileState> = {};
  for (const rel of paths) {
    checkDeadline(deadline);
    if (isIgnored(rel)) continue;
    const abs = path.join(repoRoot, rel);
    const st = statFile(abs);
    if (!st) continue;
    files[rel] = { mtimeMs: st.mtimeMs, size: st.size, fps: readFingerprints(abs) };
  }
  return { kind: 'shell', repoRoot, files };
}

export function shellChanges(b: ShellBaseline, isIgnored: IgnoreFn, deadline: number): Change[] {
  const paths = runWithDeadline(() => statusPaths(b.repoRoot, remainingMs(deadline)));
  if (paths.length > MAX_STATUS_FILES) return [];
  const changes: Change[] = [];
  for (const rel of paths) {
    checkDeadline(deadline);
    if (isIgnored(rel)) continue;
    const abs = path.join(b.repoRoot, rel);
    const st = statFile(abs);
    if (!st) continue;
    const prev = b.files[rel];
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
    const after = readFingerprints(abs);
    if (!after) continue;
    // pre 时已改动的文件用 pre 的指纹；否则以 HEAD 版本为基线（新文件为空）
    let before: string[] | null;
    if (prev) {
      before = prev.fps;
    } else {
      const shown = showFile(b.repoRoot, 'HEAD', rel, remainingMs(deadline));
      // showFile 经 tryGit 转发，进程超时（ETIMEDOUT）时也会返回 null，和"路径不在 HEAD 中"无法区分；
      // 这里立即复查预算：超时只会发生在预算耗尽时，借此把超时与真正的新文件区分开，避免把超时误判为新文件全量计为 AI
      checkDeadline(deadline);
      before = fingerprintText(shown ?? '');
    }
    if (!before) continue;
    const fps = multisetDiff(after, before);
    if (fps.length) changes.push({ repoRoot: b.repoRoot, rel, fps });
  }
  return changes;
}

function pendingFile(key: string): string {
  return path.join(pendingDir(), `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

export function savePending(key: string, b: Baseline): void {
  fs.mkdirSync(pendingDir(), { recursive: true });
  fs.writeFileSync(pendingFile(key), JSON.stringify(b));
}

function doneFile(key: string): string {
  return pendingFile(key).replace(/\.json$/, '.done');
}

export function hasPending(key: string): boolean {
  return fs.existsSync(pendingFile(key));
}

export function isDone(key: string): boolean {
  return fs.existsSync(doneFile(key));
}

/** 取出基线后改名为 .done，供重复触发的钩子识别“已处理” */
export function takePending(key: string): Baseline | null {
  const file = pendingFile(key);
  try {
    const b = JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
    fs.renameSync(file, doneFile(key));
    return b;
  } catch {
    return null;
  }
}

export function cleanupPending(maxAgeMs = 3600_000): void {
  let names: string[];
  try {
    names = fs.readdirSync(pendingDir());
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const file = path.join(pendingDir(), name);
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.unlinkSync(file);
    } catch {
      // 忽略
    }
  }
}

import fs from 'node:fs';
import path from 'node:path';
import type { AicodeConfig, ReporterConfig } from './config.js';
import { countUnreported } from './events.js';
import { syncStatePath } from './paths.js';
import { flushEvents, type Reporter } from './reporter/index.js';
import { describeTrack } from './track.js';

export interface SyncState {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  nextRetryAt?: string;
}

function defaultState(): SyncState {
  return { consecutiveFailures: 0 };
}

export function readSyncState(): SyncState {
  const file = syncStatePath();
  if (!fs.existsSync(file)) return defaultState();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...defaultState(), ...raw } as SyncState;
  } catch {
    // 损坏时按初始状态处理
  }
  return defaultState();
}

export function writeSyncState(s: SyncState): void {
  fs.mkdirSync(path.dirname(syncStatePath()), { recursive: true });
  fs.writeFileSync(syncStatePath(), JSON.stringify(s, null, 2) + '\n');
}

/** 失败次数 -> 退避毫秒数：1、2、4...最多 30 分钟 */
export function backoffMs(failures: number): number {
  return Math.min(2 ** (failures - 1), 30) * 60_000;
}

function recordSuccess(now: () => number): void {
  writeSyncState({
    consecutiveFailures: 0,
    lastAttemptAt: new Date(now()).toISOString(),
    lastSuccessAt: new Date(now()).toISOString(),
  });
}

function recordFailure(now: () => number, error: string | undefined): void {
  const prev = readSyncState();
  const failures = prev.consecutiveFailures + 1;
  writeSyncState({
    consecutiveFailures: failures,
    lastAttemptAt: new Date(now()).toISOString(),
    lastSuccessAt: prev.lastSuccessAt,
    lastError: error,
    nextRetryAt: new Date(now() + backoffMs(failures)).toISOString(),
  });
}

/** 反复补发直到队列清空或失败；reporter 为 noop 时不消费队列（控制器裁定，未配置上报期间事件全部保留在本地） */
export async function syncAll(reporter: Reporter, now: () => number = Date.now): Promise<{ sent: number; remaining: number; error?: string }> {
  if (reporter.name === 'noop') return { sent: 0, remaining: countUnreported() };
  let sent = 0;
  for (;;) {
    const result = await flushEvents(reporter, 50);
    sent += result.sent;
    if (result.failed) {
      recordFailure(now, result.error);
      return { sent, remaining: countUnreported(), error: result.error };
    }
    if (result.sent === 0) break;
  }
  recordSuccess(now);
  return { sent, remaining: countUnreported() };
}

/** commit 后自动补发一批；命中退避窗口时直接跳过；reporter 为 noop 时不消费队列 */
export async function autoSync(reporter: Reporter, now: () => number = Date.now): Promise<void> {
  if (reporter.name === 'noop') return;
  const state = readSyncState();
  if (state.nextRetryAt && now() < Date.parse(state.nextRetryAt)) return;
  const result = await flushEvents(reporter, 50);
  if (result.failed) recordFailure(now, result.error);
  else recordSuccess(now);
}

function describeReporter(reporter: ReporterConfig): string {
  if (reporter.type === 'mysql') {
    const o = reporter.options ?? {};
    const host = String(o.host ?? '?');
    const port = o.port ?? 3306;
    const database = String(o.database ?? '?');
    const user = String(o.user ?? '?');
    return `reporter：mysql ${host}:${port}/${database} user=${user}`;
  }
  if (reporter.type === 'module') return `reporter：module ${reporter.module ?? ''}`;
  return 'reporter：未配置（noop）';
}

export function describeStatus(config: AicodeConfig): string {
  const state = readSyncState();
  const lines = [
    describeTrack(),
    describeReporter(config.reporter),
    `本地积压事件：${countUnreported()} 条`,
    `最近尝试时间：${state.lastAttemptAt ?? '(无)'}`,
    `最近成功时间：${state.lastSuccessAt ?? '(无)'}`,
  ];
  if (state.lastError) lines.push(`最近错误：${state.lastError}`);
  lines.push(`下次自动补发时间：${state.nextRetryAt ?? '(无退避，随时可补发)'}`);
  return lines.join('\n');
}

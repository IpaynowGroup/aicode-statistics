import fs from 'node:fs';
import path from 'node:path';
import { isTrackConfig, readGlobalConfig, type AicodeConfig, type ReporterConfig } from './config.js';
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

function isValidIsoDate(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/** 把任意读到的字段收敛成合法 SyncState：字段类型不对或日期解析不了时退回默认值，绝不让脏状态文件影响退避计算 */
function sanitizeState(raw: Record<string, unknown>): SyncState {
  const state: SyncState = {
    consecutiveFailures: typeof raw.consecutiveFailures === 'number' && Number.isFinite(raw.consecutiveFailures)
      ? Math.max(0, Math.floor(raw.consecutiveFailures)) : 0,
  };
  if (isValidIsoDate(raw.lastAttemptAt)) state.lastAttemptAt = raw.lastAttemptAt;
  if (isValidIsoDate(raw.lastSuccessAt)) state.lastSuccessAt = raw.lastSuccessAt;
  if (isValidIsoDate(raw.nextRetryAt)) state.nextRetryAt = raw.nextRetryAt;
  if (typeof raw.lastError === 'string') state.lastError = raw.lastError;
  return state;
}

export function readSyncState(): SyncState {
  const file = syncStatePath();
  if (!fs.existsSync(file)) return defaultState();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return sanitizeState(raw as Record<string, unknown>);
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

/**
 * 反复补发直到队列清空或失败；reporter 为 noop 时不消费队列（控制器裁定，未配置上报期间事件全部保留在本地）。
 * flushEvents 会跳过缺合法 event_id 的脏事件（既不上报也不标记），所以只要队列里还有能被处理的事件，
 * 每批 sent 必然 > 0；一旦某批 sent === 0 且未失败，说明剩下的（如果有）全是无法处理的脏数据，循环自然结束，
 * 不需要额外的"批次首元素重复"守卫（曾经加过，会在脏数据排在队首、后面还有大量正常事件时把同步提前打断）。
 */
export async function syncAll(
  reporter: Reporter,
  now: () => number = Date.now,
): Promise<{ sent: number; remaining: number; failed: boolean; error?: string }> {
  if (reporter.name === 'noop') return { sent: 0, remaining: countUnreported(), failed: false };
  let sent = 0;
  for (;;) {
    const result = await flushEvents(reporter, 50);
    sent += result.sent;
    if (result.failed) {
      recordFailure(now, result.error);
      return { sent, remaining: countUnreported(), failed: true, error: result.error };
    }
    if (result.sent === 0) break;
  }
  recordSuccess(now);
  return { sent, remaining: countUnreported(), failed: false };
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
  const lines: string[] = [];
  // track 字段类型错误时 loadConfig/getTrack 已按默认值（全部仓库）兜底，这里额外提示用户配置有问题
  const rawTrack = readGlobalConfig().track;
  if (rawTrack !== undefined && !isTrackConfig(rawTrack)) lines.push('track 字段无效，已按统计全部仓库处理');
  lines.push(
    describeTrack(),
    describeReporter(config.reporter),
    `本地积压事件：${countUnreported()} 条`,
    `最近尝试时间：${state.lastAttemptAt ?? '(无)'}`,
    `最近成功时间：${state.lastSuccessAt ?? '(无)'}`,
  );
  if (state.consecutiveFailures > 0) lines.push(`最近错误：${state.lastError ?? '(未知错误)'}`);
  lines.push(`下次自动补发时间：${state.nextRetryAt ?? '(无退避，随时可补发)'}`);
  return lines.join('\n');
}

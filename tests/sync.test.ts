import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultTrack, type AicodeConfig } from '../src/config.js';
import { appendEvent, countUnreported, type CommitEvent } from '../src/events.js';
import { syncStatePath } from '../src/paths.js';
import { flushEvents, type Reporter } from '../src/reporter/index.js';
import { autoSync, backoffMs, describeStatus, readSyncState, syncAll, writeSyncState } from '../src/sync.js';
import { tmpHome } from './helpers.js';

const ev = (id: string): CommitEvent => ({
  event_id: id, repo: 'r', branch: 'main', commit_sha: id, parent_sha: null, commit_message: 'm',
  committed_at: '2026-09-24T10:00:00+08:00', amend: false, owner: { name: 'n', email: 'e' }, module: 'unknown',
  stats: { added_total: 0, added_ai: 0, added_human: 0, deleted_total: 0, ai_ratio: 0, ai_generated: 0, ai_accept_rate: 0, by_tool: {} },
  files: [], client_version: '0.1.0',
});

/** 每调用一次 report 计数一次；opts.failAt 指定第几次调用（从 1 开始）失败 */
function makeCountingReporter(name: string, opts: { failAt?: number } = {}): { reporter: Reporter; calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  const reporter: Reporter = {
    name,
    report: async (e) => {
      n++;
      if (opts.failAt && n === opts.failAt) throw new Error('网关不可用');
      calls.push(e.event_id);
    },
  };
  return { reporter, calls };
}

beforeEach(() => {
  tmpHome();
});

describe('flushEvents 返回值', () => {
  it('全部成功时 sent 为总数，failed 为 false，error 为 undefined', async () => {
    appendEvent(ev('a'));
    appendEvent(ev('b'));
    const { reporter, calls } = makeCountingReporter('ok');
    const result = await flushEvents(reporter);
    expect(result).toEqual({ sent: 2, failed: false });
    expect(calls).toEqual(['a', 'b']);
  });

  it('第二条失败时 sent=1、failed=true、error 为错误消息', async () => {
    appendEvent(ev('a'));
    appendEvent(ev('b'));
    const { reporter } = makeCountingReporter('fail', { failAt: 2 });
    const result = await flushEvents(reporter);
    expect(result).toEqual({ sent: 1, failed: true, error: '网关不可用' });
  });
});

describe('syncAll', () => {
  it('120 条事件分批全部发送，remaining=0，consecutiveFailures=0', async () => {
    for (let i = 0; i < 120; i++) appendEvent(ev(`e${i}`));
    const { reporter } = makeCountingReporter('ok');
    const result = await syncAll(reporter);
    expect(result).toEqual({ sent: 120, remaining: 0 });
    expect(countUnreported()).toBe(0);
    expect(readSyncState().consecutiveFailures).toBe(0);
  });

  it('失败时 consecutiveFailures 递增、nextRetryAt=now+backoff（用注入的 now）', async () => {
    appendEvent(ev('a'));
    appendEvent(ev('b'));
    const { reporter } = makeCountingReporter('fail', { failAt: 2 });
    const now = () => 1_000_000;
    const result = await syncAll(reporter, now);
    expect(result.sent).toBe(1);
    expect(result.error).toBe('网关不可用');
    const state = readSyncState();
    expect(state.consecutiveFailures).toBe(1);
    expect(state.nextRetryAt).toBe(new Date(now() + backoffMs(1)).toISOString());
    expect(state.lastError).toBe('网关不可用');
  });
});

describe('backoffMs', () => {
  it.each([
    [1, 1 * 60_000],
    [2, 2 * 60_000],
    [3, 4 * 60_000],
    [6, 30 * 60_000],
    [10, 30 * 60_000],
  ])('failures=%i -> %ims', (failures, expected) => {
    expect(backoffMs(failures)).toBe(expected);
  });
});

describe('autoSync', () => {
  it('now < nextRetryAt 时不调用 reporter.report；到期后调用，成功则清零', async () => {
    appendEvent(ev('a'));
    writeSyncState({ consecutiveFailures: 1, nextRetryAt: new Date(1_000_000).toISOString() });
    const { reporter, calls } = makeCountingReporter('ok');

    await autoSync(reporter, () => 500_000);
    expect(calls).toEqual([]);
    expect(countUnreported()).toBe(1);
    expect(readSyncState().consecutiveFailures).toBe(1); // 未尝试，状态不变

    await autoSync(reporter, () => 1_500_000);
    expect(calls).toEqual(['a']);
    expect(countUnreported()).toBe(0);
    expect(readSyncState().consecutiveFailures).toBe(0);
  });
});

describe('noop 不消费队列（控制器裁定）', () => {
  it('syncAll 对 noop 直接返回，不标记事件已上报、不改状态', async () => {
    appendEvent(ev('a'));
    const noop: Reporter = { name: 'noop', async report() {} };
    const result = await syncAll(noop);
    expect(result).toEqual({ sent: 0, remaining: 1 });
    expect(countUnreported()).toBe(1);
    expect(fs.existsSync(syncStatePath())).toBe(false);
  });

  it('autoSync 对 noop 直接返回，不标记事件已上报、不改状态', async () => {
    appendEvent(ev('a'));
    const noop: Reporter = { name: 'noop', async report() {} };
    await autoSync(noop);
    expect(countUnreported()).toBe(1);
    expect(fs.existsSync(syncStatePath())).toBe(false);
  });
});

describe('describeStatus', () => {
  it('mysql 配置下不包含密码，包含 host 与积压条数', () => {
    appendEvent(ev('a'));
    const config: AicodeConfig = {
      modules: [], ignore: [], track: defaultTrack(),
      reporter: { type: 'mysql', options: { host: 'db.internal', port: 3306, database: 'aicode', user: 'reporter', password: 'sup3rsecret' } },
    };
    const out = describeStatus(config);
    expect(out).not.toContain('sup3rsecret');
    expect(out).toContain('db.internal');
    expect(out).toContain('积压');
  });
});

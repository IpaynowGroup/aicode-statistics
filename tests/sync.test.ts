import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultTrack, type AicodeConfig } from '../src/config.js';
import { appendEvent, countUnreported, type CommitEvent } from '../src/events.js';
import { eventsPath, syncStatePath } from '../src/paths.js';
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

  it('错误消息为空（如 Node AggregateError）时仍判定失败，error 非空（回退到 name）', async () => {
    appendEvent(ev('a'));
    const reporter: Reporter = {
      name: 'fail-empty-message',
      report: async () => { throw new AggregateError([new Error('a')]); },
    };
    const result = await flushEvents(reporter);
    expect(result.failed).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.error).toBeTruthy();
    expect(result.error).toBe('AggregateError');
  });
});

describe('syncAll', () => {
  it('120 条事件分批全部发送，remaining=0，consecutiveFailures=0', async () => {
    for (let i = 0; i < 120; i++) appendEvent(ev(`e${i}`));
    const { reporter } = makeCountingReporter('ok');
    const result = await syncAll(reporter);
    expect(result).toEqual({ sent: 120, remaining: 0, failed: false });
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
    expect(result.failed).toBe(true);
    expect(result.error).toBe('网关不可用');
    const state = readSyncState();
    expect(state.consecutiveFailures).toBe(1);
    expect(state.nextRetryAt).toBe(new Date(now() + backoffMs(1)).toISOString());
    expect(state.lastError).toBe('网关不可用');
  });

  it('错误消息为空（AggregateError）时 failed=true，error 非空，consecutiveFailures 正常递增', async () => {
    appendEvent(ev('a'));
    const reporter: Reporter = {
      name: 'fail-empty-message',
      report: async () => { throw new AggregateError([new Error('a')]); },
    };
    const result = await syncAll(reporter, () => 1_000_000);
    expect(result.failed).toBe(true);
    expect(result.error).toBeTruthy();
    expect(readSyncState().consecutiveFailures).toBe(1);
    expect(readSyncState().lastError).toBeTruthy();
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
    expect(result).toEqual({ sent: 0, remaining: 1, failed: false });
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

  it('consecutiveFailures > 0 时展示最近错误，即使 lastError 恰好为空字符串也不隐藏该行', async () => {
    appendEvent(ev('a'));
    const reporter: Reporter = {
      name: 'fail-empty-message',
      report: async () => { throw new AggregateError([new Error('a')]); },
    };
    await syncAll(reporter, () => 1_000_000);
    const config: AicodeConfig = { modules: [], ignore: [], track: defaultTrack(), reporter: { type: 'module', module: '/x.js' } };
    const out = describeStatus(config);
    expect(out).toContain('最近错误');
  });
});

describe('readSyncState 对非法字段做类型兜底（见控制器裁定）', () => {
  it('consecutiveFailures 非数字时按 0 处理；非法日期字符串按 undefined 处理；退避计算不受影响', () => {
    fs.mkdirSync(path.dirname(syncStatePath()), { recursive: true });
    fs.writeFileSync(syncStatePath(), JSON.stringify({
      consecutiveFailures: 'x',
      lastAttemptAt: 'not-a-date',
      lastSuccessAt: 123,
      nextRetryAt: 'also-not-a-date',
      lastError: 42,
    }));
    const state = readSyncState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastAttemptAt).toBeUndefined();
    expect(state.lastSuccessAt).toBeUndefined();
    expect(state.nextRetryAt).toBeUndefined();
    expect(state.lastError).toBeUndefined();
    expect(() => backoffMs(state.consecutiveFailures + 1)).not.toThrow();
    expect(backoffMs(state.consecutiveFailures + 1)).toBe(60_000);
  });

  it('consecutiveFailures 为负数时按 0 处理（Math.max(0, ...) 兜底）', () => {
    fs.mkdirSync(path.dirname(syncStatePath()), { recursive: true });
    fs.writeFileSync(syncStatePath(), JSON.stringify({ consecutiveFailures: -3 }));
    expect(readSyncState().consecutiveFailures).toBe(0);
  });
});

describe('syncAll 对缺合法 event_id 的脏事件：跳过但不提前终止整个同步（见控制器裁定，去掉多余的批次首元素重复守卫）', () => {
  it('事件缺少合法 event_id 时被跳过、不标记已上报；即便它永远排在队首，syncAll 仍能正常终止（不死循环）', async () => {
    // 直接往 events.jsonl 写一条缺 event_id 的脏数据，混在正常事件之间
    fs.mkdirSync(path.dirname(eventsPath()), { recursive: true });
    fs.appendFileSync(eventsPath(), JSON.stringify({ repo: 'r', commit_sha: 'bad' }) + '\n');
    appendEvent(ev('a'));
    appendEvent(ev('b'));

    const { reporter, calls } = makeCountingReporter('lenient');
    const result = await syncAll(reporter);

    expect(calls).toEqual(['a', 'b']);
    expect(result.sent).toBe(2);
    expect(countUnreported()).toBe(1); // 脏数据留在队列里，但不会阻塞正常事件，也不会无限重试
  });

  it('事件全部缺少合法 event_id 时，syncAll 立即终止且不报告任何事件', async () => {
    fs.mkdirSync(path.dirname(eventsPath()), { recursive: true });
    fs.appendFileSync(eventsPath(), JSON.stringify({ repo: 'r', commit_sha: 'bad1' }) + '\n');
    fs.appendFileSync(eventsPath(), JSON.stringify({ repo: 'r', commit_sha: 'bad2' }) + '\n');

    const { reporter, calls } = makeCountingReporter('lenient');
    const result = await syncAll(reporter);

    expect(calls).toEqual([]);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(false);
    expect(countUnreported()).toBe(2);
  });

  it('1 条脏数据排在队首 + 120 条正常事件：syncAll 发送全部 120 条而不是提前中止（回归：曾经的批次首元素重复守卫会在此场景提前打断，见控制器裁定）', async () => {
    fs.mkdirSync(path.dirname(eventsPath()), { recursive: true });
    fs.appendFileSync(eventsPath(), JSON.stringify({ repo: 'r', commit_sha: 'bad' }) + '\n'); // 排在最前面、永远无法被标记已上报
    for (let i = 0; i < 120; i++) appendEvent(ev(`e${i}`));

    const { reporter, calls } = makeCountingReporter('lenient');
    const result = await syncAll(reporter);

    expect(calls).toHaveLength(120);
    expect(result.sent).toBe(120);
    expect(result.failed).toBe(false);
    expect(countUnreported()).toBe(1); // 只剩那条脏数据
  });
});

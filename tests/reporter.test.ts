import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, hasEvent, readUnreported, type CommitEvent } from '../src/events.js';
import { flushEvents, loadReporter, noopReporter, type Reporter } from '../src/reporter/index.js';
import { logPath } from '../src/paths.js';
import { tmpHome } from './helpers.js';

const ev = (id: string): CommitEvent => ({
  event_id: id, repo: 'r', branch: 'main', commit_sha: id, parent_sha: null, commit_message: 'm',
  committed_at: '2026-09-24T10:00:00+08:00', amend: false, owner: { name: 'n', email: 'e' }, module: 'unknown',
  stats: { added_total: 0, added_ai: 0, added_human: 0, deleted_total: 0, ai_ratio: 0, ai_generated: 0, ai_accept_rate: 0, by_tool: {} },
  files: [], client_version: '0.1.0',
});

let home: string;
beforeEach(() => {
  home = tmpHome();
});

describe('events', () => {
  it('追加、判重、读取未上报事件', () => {
    appendEvent(ev('a'));
    appendEvent(ev('b'));
    expect(hasEvent('a')).toBe(true);
    expect(hasEvent('z')).toBe(false);
    expect(readUnreported(1).map((e) => e.event_id)).toEqual(['a']);
  });
});

describe('reporter', () => {
  it('默认使用 noop，flush 后事件被标记为已上报', async () => {
    appendEvent(ev('a'));
    const reporter = await loadReporter({ type: 'noop' });
    expect(reporter).toBe(noopReporter);
    await flushEvents(reporter);
    expect(readUnreported(50)).toEqual([]);
  });

  it('加载自定义模块，并把 options 原样传入', async () => {
    const out = path.join(home, 'out.txt');
    const mod = path.join(home, 'my-reporter.mjs');
    fs.writeFileSync(mod, "import fs from 'node:fs';\nexport default (o) => ({ name: 'file', async report(e) { fs.appendFileSync(o.out, e.event_id + '\\n'); } });\n");
    appendEvent(ev('a'));
    appendEvent(ev('b'));
    await flushEvents(await loadReporter({ type: 'module', module: mod, options: { out } }));
    expect(fs.readFileSync(out, 'utf8')).toBe('a\nb\n');
  });

  it('type=module 但 module 是相对路径时记日志并回退 noop（见 F8）', async () => {
    const reporter = await loadReporter({ type: 'module', module: './my-reporter.mjs' });
    expect(reporter).toBe(noopReporter);
    expect(fs.readFileSync(logPath(), 'utf8')).toContain('绝对路径');
  });

  it('type=module 但缺少 module 字段时记日志并回退 noop（见 F8）', async () => {
    const reporter = await loadReporter({ type: 'module' });
    expect(reporter).toBe(noopReporter);
    expect(fs.readFileSync(logPath(), 'utf8')).toContain('缺少 module');
  });

  it('上报失败时停止，失败的事件保留，下次补发；无论成败都调用 close', async () => {
    appendEvent(ev('a'));
    appendEvent(ev('b'));
    let closed = 0;
    const failing: Reporter = {
      name: 'fail',
      report: async (e) => { if (e.event_id === 'b') throw new Error('网关不可用'); },
      close: async () => { closed++; },
    };
    await flushEvents(failing);
    expect(readUnreported(50).map((e) => e.event_id)).toEqual(['b']);
    expect(closed).toBe(1);
  });
});

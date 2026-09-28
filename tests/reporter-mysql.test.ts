import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommitEvent } from '../src/events.js';
import { repoKey } from '../src/git.js';
import { loadReporter } from '../src/reporter/index.js';
import {
  createMysqlReporter, INSERT_COMMIT_SQL, INSERT_FILE_SQL, INSERT_TOOL_SQL, resolveMysqlOptions, toMysqlDatetime,
  type SqlConnection,
} from '../src/reporter/mysql.js';

const event: CommitEvent = {
  event_id: 'gitlab.example.com/g/p:' + 'a'.repeat(40),
  repo: 'gitlab.example.com/g/p',
  branch: 'feature/login',
  commit_sha: 'a'.repeat(40),
  parent_sha: null,
  commit_message: 'feat: 登录 🚀',
  committed_at: '2026-09-24T10:00:00+08:00',
  amend: true,
  owner: { name: '张三', email: 'z@example.com' },
  module: 'login',
  stats: {
    added_total: 3, added_ai: 2, added_human: 1, deleted_total: 0, ai_ratio: 0.667, ai_generated: 2, ai_accept_rate: 1,
    by_tool: { 'claude-code/claude-opus-5-5': { ai: 1, generated: 1 }, 'codex/gpt-5.6-luna': { ai: 1, generated: 1 } },
  },
  files: [{ path: 'src/a.ts', module: 'login', added: 3, ai: 2 }],
  client_version: '0.1.0',
};
const baseOptions = { host: 'db', user: 'aicode_writer', database: 'ai_stats', password: 'from-config' };

function fakeConnection(failOn?: string) {
  const calls: string[] = [];
  const executed: { sql: string; params: unknown[] }[] = [];
  const conn: SqlConnection = {
    beginTransaction: async () => calls.push('begin'),
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    execute: async (sql, params) => {
      if (failOn && sql === failOn) throw new Error('写入失败');
      executed.push({ sql, params });
      calls.push('execute');
    },
    end: async () => calls.push('end'),
  };
  return { conn, calls, executed };
}

afterEach(() => {
  delete process.env.AICODE_MYSQL_PASSWORD;
});

describe('参数解析', () => {
  it('ISO 时间转为 UTC DATETIME', () => {
    expect(toMysqlDatetime('2026-09-24T10:00:00+08:00')).toBe('2026-09-24 02:00:00');
  });

  it('密码优先取环境变量；缺少必填项时报错', () => {
    expect(resolveMysqlOptions(baseOptions)).toEqual({ ...baseOptions, port: 3306, connectTimeout: 5000 });
    process.env.AICODE_MYSQL_PASSWORD = 'from-env';
    expect(resolveMysqlOptions(baseOptions).password).toBe('from-env');
    expect(() => resolveMysqlOptions({ host: 'db' })).toThrow('host、user、database');
  });
});

describe('createMysqlReporter', () => {
  it('在一个事务内写入 commit、文件和工具三张表', async () => {
    const f = fakeConnection();
    const reporter = createMysqlReporter(baseOptions, async () => f.conn);
    await reporter.report(event);
    expect(f.calls).toEqual(['begin', 'execute', 'execute', 'execute', 'execute', 'commit']);
    const key = repoKey(event.repo);
    expect(f.executed[0]).toEqual({
      sql: INSERT_COMMIT_SQL,
      params: [
        key, event.commit_sha, event.repo, 'feature/login', null, 'feat: 登录 🚀', '2026-09-24 02:00:00', 1,
        '张三', 'z@example.com', 'login', 3, 2, 1, 0, 0.667, 2, 1, '0.1.0',
      ],
    });
    expect(f.executed[1]).toEqual({
      sql: INSERT_FILE_SQL,
      params: [key, event.commit_sha, createHash('sha1').update('src/a.ts').digest('hex'), 'src/a.ts', 'login', 3, 2],
    });
    expect(f.executed.slice(2)).toEqual([
      { sql: INSERT_TOOL_SQL, params: [key, event.commit_sha, 'claude-code', 'claude-opus-5-5', 1, 1] },
      { sql: INSERT_TOOL_SQL, params: [key, event.commit_sha, 'codex', 'gpt-5.6-luna', 1, 1] },
    ]);
  });

  it('所有语句都用 INSERT IGNORE，保证重复上报幂等', () => {
    for (const sql of [INSERT_COMMIT_SQL, INSERT_FILE_SQL, INSERT_TOOL_SQL]) expect(sql.startsWith('INSERT IGNORE INTO ')).toBe(true);
  });

  it('写入失败时回滚并抛出，让事件留待下次补发', async () => {
    const f = fakeConnection(INSERT_FILE_SQL);
    const reporter = createMysqlReporter(baseOptions, async () => f.conn);
    await expect(reporter.report(event)).rejects.toThrow('写入失败');
    expect(f.calls).toEqual(['begin', 'execute', 'rollback']);
  });

  it('多个事件共用一个连接，close 时关闭', async () => {
    const f = fakeConnection();
    let created = 0;
    const reporter = createMysqlReporter(baseOptions, async () => {
      created++;
      return f.conn;
    });
    await reporter.report(event);
    await reporter.report({ ...event, commit_sha: 'b'.repeat(40) });
    await reporter.close?.();
    expect(created).toBe(1);
    expect(f.calls.at(-1)).toBe('end');
  });

  it('loadReporter 支持 type=mysql，且在首次 report 前不建立连接', async () => {
    const reporter = await loadReporter({ type: 'mysql', options: baseOptions });
    expect(reporter.name).toBe('mysql');
    await reporter.close?.();
  });
});

// 仅在提供测试库时运行，例如：AICODE_TEST_MYSQL_URL=mysql://root:pwd@127.0.0.1:3306/ai_stats_test
const url = process.env.AICODE_TEST_MYSQL_URL;
describe.skipIf(!url)('真实 MySQL 集成', () => {
  it('建表后重复上报同一事件，只保留一行', async () => {
    const mysql = await import('mysql2/promise');
    const admin = await mysql.createConnection({ uri: url!, multipleStatements: true });
    await admin.query('DROP TABLE IF EXISTS ai_commit, ai_commit_file, ai_commit_tool');
    await admin.query(fs.readFileSync(path.resolve('sql/schema.sql'), 'utf8'));
    const u = new URL(url!);
    const reporter = createMysqlReporter({
      host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database: u.pathname.slice(1),
    });
    await reporter.report(event);
    await reporter.report(event);
    await reporter.close?.();
    const [rows] = await admin.query('SELECT COUNT(*) AS n FROM ai_commit');
    const [tools] = await admin.query('SELECT COUNT(*) AS n FROM ai_commit_tool');
    await admin.end();
    expect((rows as { n: number }[])[0].n).toBe(1);
    expect((tools as { n: number }[])[0].n).toBe(2);
  });
});

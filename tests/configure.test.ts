import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { readGlobalConfig, updateGlobalConfig } from '../src/config.js';
import {
  disableMysql, hasInsertGrant, runMysqlWizard, testMysql, type MysqlProbe, type Prompter,
} from '../src/configure.js';
import { configPath } from '../src/paths.js';
import { tmpHome } from './helpers.js';

beforeEach(() => {
  tmpHome();
});

// ---- 假 Prompter：脚本化回答；ask 遵循真实 createTtyPrompter 的约定——空字符串表示回车，取默认值 ----
function fakePrompter(script: { ask?: string[]; askSecret?: string[]; confirm?: boolean[] }): { prompter: Prompter; log: string[] } {
  const log: string[] = [];
  let ai = 0;
  let si = 0;
  let ci = 0;
  const prompter: Prompter = {
    async ask(question, def) {
      const answer = script.ask?.[ai++] ?? '';
      log.push(`ask:${question}=${JSON.stringify(answer)}`);
      return answer === '' ? (def ?? '') : answer;
    },
    async askSecret(question) {
      const answer = script.askSecret?.[si++] ?? '';
      log.push(`askSecret:${question}`);
      return answer;
    },
    async confirm(question) {
      const answer = script.confirm?.[ci++] ?? false;
      log.push(`confirm:${question}=${answer}`);
      return answer;
    },
  };
  return { prompter, log };
}

interface FakeProbeOptions {
  connectError?: Error;
  queryError?: Error;
  grants?: string[];
}

function fakeProbe(opts: FakeProbeOptions = {}): { probe: MysqlProbe; ended: boolean[]; queries: string[] } {
  const queries: string[] = [];
  const ended: boolean[] = [];
  const probe: MysqlProbe = {
    async connect() {
      if (opts.connectError) throw opts.connectError;
      return {
        async query(sql: string) {
          queries.push(sql);
          if (opts.queryError) throw opts.queryError;
          if (sql.startsWith('SHOW GRANTS')) return (opts.grants ?? []).map((g) => ({ 'Grants for root@%': g }));
          return [];
        },
        async end() {
          ended.push(true);
        },
      };
    },
  };
  return { probe, ended, queries };
}

const baseOpts = { host: 'db', port: 3306, user: 'aicode_writer', password: 'secret-pw', database: 'ai_stats', connectTimeout: 5000 };

describe('hasInsertGrant', () => {
  it('库级 INSERT 授权通过', () => {
    expect(hasInsertGrant(['GRANT INSERT ON `ai_stats`.* TO `u`@`%`'], 'ai_stats')).toBe(true);
  });
  it('全局 ALL PRIVILEGES 通过', () => {
    expect(hasInsertGrant(['GRANT ALL PRIVILEGES ON *.* TO `u`@`%`'], 'ai_stats')).toBe(true);
  });
  it('三张表分别授予 INSERT 通过', () => {
    expect(hasInsertGrant([
      'GRANT INSERT ON `ai_stats`.`ai_commit` TO `u`@`%`',
      'GRANT INSERT ON `ai_stats`.`ai_commit_file` TO `u`@`%`',
      'GRANT INSERT ON `ai_stats`.`ai_commit_tool` TO `u`@`%`',
    ], 'ai_stats')).toBe(true);
  });
  it('只有两张表授权不通过', () => {
    expect(hasInsertGrant([
      'GRANT INSERT ON `ai_stats`.`ai_commit` TO `u`@`%`',
      'GRANT INSERT ON `ai_stats`.`ai_commit_file` TO `u`@`%`',
    ], 'ai_stats')).toBe(false);
  });
  it('只有 SELECT 不通过', () => {
    expect(hasInsertGrant(['GRANT SELECT ON ai_stats.* TO `u`@`%`'], 'ai_stats')).toBe(false);
  });
  it('授权在其他库上不通过', () => {
    expect(hasInsertGrant(['GRANT ALL PRIVILEGES ON `other_db`.* TO `u`@`%`'], 'ai_stats')).toBe(false);
  });
});

describe('testMysql', () => {
  it('连接失败时返回 ok=false，原因不含密码，并调用了 end 之外不应崩溃', async () => {
    const { probe } = fakeProbe({ connectError: new Error('ECONNREFUSED 127.0.0.1:3306') });
    const result = await testMysql(baseOpts, probe);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(baseOpts.password);
    expect(result.message).toContain('ECONNREFUSED');
  });

  it('无 INSERT 权限时返回 ok=false', async () => {
    const { probe, ended } = fakeProbe({ grants: ['GRANT SELECT ON ai_stats.* TO `u`@`%`'] });
    const result = await testMysql(baseOpts, probe);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(baseOpts.password);
    expect(ended).toEqual([true]);
  });

  it('权限充足时返回 ok=true，并调用了 end', async () => {
    const { probe, ended } = fakeProbe({ grants: ['GRANT ALL PRIVILEGES ON *.* TO `u`@`%`'] });
    const result = await testMysql(baseOpts, probe);
    expect(result.ok).toBe(true);
    expect(ended).toEqual([true]);
  });

  it('查询阶段失败也会关闭连接', async () => {
    const { probe, ended } = fakeProbe({ queryError: new Error('SELECT 1 失败') });
    const result = await testMysql(baseOpts, probe);
    expect(result.ok).toBe(false);
    expect(ended).toEqual([true]);
  });
});

describe('runMysqlWizard', () => {
  it('成功路径：写入全局配置 reporter=mysql，保留其他字段，文件权限 600', async () => {
    updateGlobalConfig((raw) => {
      raw.owner = { name: 'Someone' };
    });
    const { prompter } = fakePrompter({
      ask: ['db-host', '3307', 'ai_stats', 'writer'],
      askSecret: ['pw123'],
    });
    const { probe } = fakeProbe({ grants: ['GRANT ALL PRIVILEGES ON *.* TO `u`@`%`'] });
    const code = await runMysqlWizard(prompter, probe);
    expect(code).toBe(0);
    const cfg = readGlobalConfig();
    expect(cfg.reporter).toEqual({
      type: 'mysql',
      options: { host: 'db-host', port: 3307, user: 'writer', password: 'pw123', database: 'ai_stats' },
    });
    expect(cfg.owner).toEqual({ name: 'Someone' });
    const mode = fs.statSync(configPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('已有配置时回车沿用默认值，包括密码沿用原密码', async () => {
    updateGlobalConfig((raw) => {
      raw.reporter = {
        type: 'mysql',
        options: { host: 'old-host', port: 3308, user: 'old-user', password: 'old-pw', database: 'old-db' },
      };
    });
    const { prompter } = fakePrompter({
      ask: ['', '', '', ''],
      askSecret: [''],
    });
    const { probe } = fakeProbe({ grants: ['GRANT ALL PRIVILEGES ON *.* TO `u`@`%`'] });
    const code = await runMysqlWizard(prompter, probe);
    expect(code).toBe(0);
    const cfg = readGlobalConfig();
    expect(cfg.reporter).toEqual({
      type: 'mysql',
      options: { host: 'old-host', port: 3308, user: 'old-user', password: 'old-pw', database: 'old-db' },
    });
  });

  it('测试失败且用户拒绝保存 -> 返回 1，配置未改', async () => {
    const before = readGlobalConfig();
    const { prompter } = fakePrompter({
      ask: ['host', '3306', 'db', 'user'],
      askSecret: ['pw'],
      confirm: [false],
    });
    const { probe } = fakeProbe({ connectError: new Error('连不上') });
    const code = await runMysqlWizard(prompter, probe);
    expect(code).toBe(1);
    expect(readGlobalConfig()).toEqual(before);
  });

  it('测试失败但用户确认仍保存 -> 返回 0 并保存', async () => {
    const { prompter } = fakePrompter({
      ask: ['host', '3306', 'db', 'user'],
      askSecret: ['pw'],
      confirm: [true],
    });
    const { probe } = fakeProbe({ connectError: new Error('连不上') });
    const code = await runMysqlWizard(prompter, probe);
    expect(code).toBe(0);
    const cfg = readGlobalConfig();
    expect(cfg.reporter).toEqual({
      type: 'mysql',
      options: { host: 'host', port: 3306, user: 'user', password: 'pw', database: 'db' },
    });
  });

  it('端口非法两次 -> 返回 1，配置未改', async () => {
    const before = readGlobalConfig();
    const { prompter } = fakePrompter({
      ask: ['host', 'not-a-port', 'still-bad'],
    });
    const { probe } = fakeProbe();
    const code = await runMysqlWizard(prompter, probe);
    expect(code).toBe(1);
    expect(readGlobalConfig()).toEqual(before);
  });

  it('输出与 Prompter 记录中不出现密码', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    console.error = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      const { prompter, log } = fakePrompter({
        ask: ['host', '3306', 'db', 'user'],
        askSecret: ['super-secret-pw'],
      });
      const { probe } = fakeProbe({ grants: ['GRANT ALL PRIVILEGES ON *.* TO `u`@`%`'] });
      await runMysqlWizard(prompter, probe);
      for (const line of [...logs, ...log]) expect(line).not.toContain('super-secret-pw');
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });
});

describe('disableMysql', () => {
  it('把 reporter 改为 noop 并保留其他字段', () => {
    updateGlobalConfig((raw) => {
      raw.owner = { name: 'Someone' };
      raw.reporter = { type: 'mysql', options: { host: 'h', port: 3306, user: 'u', database: 'd' } };
    });
    disableMysql();
    const cfg = readGlobalConfig();
    expect(cfg.reporter).toEqual({ type: 'noop' });
    expect(cfg.owner).toEqual({ name: 'Someone' });
  });
});

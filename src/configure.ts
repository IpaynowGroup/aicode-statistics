import readline from 'node:readline';
import { readGlobalConfig, updateGlobalConfig, type ReporterConfig } from './config.js';
import type { MysqlOptions } from './reporter/mysql.js';

export interface Prompter {
  ask(question: string, def?: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

/** 基于 readline 的交互式 Prompter：ask 展示默认值、空输入回车沿用默认值；askSecret 不回显输入 */
export function createTtyPrompter(): Prompter {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question, def) {
      const suffix = def ? `（默认 ${def}）` : '';
      return new Promise((resolve) => {
        rl.question(`${question}${suffix}: `, (answer) => {
          resolve(answer.trim() || def || '');
        });
      });
    },
    askSecret(question) {
      return new Promise((resolve) => {
        // 借用 readline 内部的行编辑（支持退格），只是拦截输出以不回显字符
        const rlInternal = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
        const originalWrite = rlInternal._writeToOutput.bind(rlInternal);
        let promptWritten = false;
        rlInternal._writeToOutput = (stringToWrite: string) => {
          if (!promptWritten) {
            originalWrite(stringToWrite);
            return;
          }
          if (stringToWrite === '\r\n' || stringToWrite === '\n') originalWrite(stringToWrite);
        };
        rl.question(`${question}: `, (answer) => {
          rlInternal._writeToOutput = originalWrite;
          resolve(answer);
        });
        promptWritten = true;
      });
    },
    confirm(question) {
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          resolve(/^y(es)?$/i.test(answer.trim()));
        });
      });
    },
  };
}

export interface MysqlProbe {
  connect(opts: MysqlOptions): Promise<{ query(sql: string): Promise<unknown[]>; end(): Promise<void> }>;
}

/** 默认探测实现：动态加载 mysql2，避免非 mysql 场景（如钩子路径）引入该依赖 */
export const defaultProbe: MysqlProbe = {
  async connect(opts) {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({ ...opts, connectTimeout: 5000 });
    return {
      async query(sql: string) {
        const [rows] = await conn.query(sql);
        return rows as unknown[];
      },
      async end() {
        await conn.end();
      },
    };
  },
};

const REQUIRED_TABLES = ['ai_commit', 'ai_commit_file', 'ai_commit_tool'];

/** 解析 `db.table` / `` `db`.`table` `` / `*.*` 等形式的授权作用域，去除反引号 */
function parseScope(scope: string): { db: string; table: string } {
  const stripped = scope.replace(/`/g, '');
  const idx = stripped.lastIndexOf('.');
  if (idx === -1) return { db: stripped, table: '*' };
  return { db: stripped.slice(0, idx), table: stripped.slice(idx + 1) };
}

/**
 * 判断 SHOW GRANTS 的结果是否已具备写入所需的 INSERT 权限：
 * 全局 / 库级 ALL PRIVILEGES 或 INSERT 均视为满足；否则要求对三张目标表分别持有 INSERT。
 */
export function hasInsertGrant(grants: string[], database: string): boolean {
  const tablesWithInsert = new Set<string>();
  for (const line of grants) {
    const m = /GRANT\s+(.+?)\s+ON\s+(\S+)\s+TO\b/i.exec(line);
    if (!m) continue;
    const privs = m[1].toUpperCase();
    const { db, table } = parseScope(m[2]);
    const dbMatches = db === '*' || db.toLowerCase() === database.toLowerCase();
    if (!dbMatches) continue;
    const isAll = /\bALL PRIVILEGES\b/.test(privs) || /(^|,)\s*ALL\s*(,|$)/.test(privs);
    const hasInsert = /\bINSERT\b/.test(privs);
    if (table === '*') {
      if (isAll || hasInsert) return true;
      continue;
    }
    if (hasInsert && REQUIRED_TABLES.includes(table.toLowerCase())) tablesWithInsert.add(table.toLowerCase());
  }
  return REQUIRED_TABLES.every((t) => tablesWithInsert.has(t));
}

/** 连接 → SELECT 1 → SHOW GRANTS FOR CURRENT_USER() → 校验 INSERT 权限；任何一步失败都返回中文原因（不含密码） */
export async function testMysql(opts: MysqlOptions, probe: MysqlProbe): Promise<{ ok: boolean; message: string }> {
  let conn: Awaited<ReturnType<MysqlProbe['connect']>> | null = null;
  try {
    conn = await probe.connect(opts);
    await conn.query('SELECT 1');
    const rows = await conn.query('SHOW GRANTS FOR CURRENT_USER()');
    const grants = rows.map((row) => {
      if (row && typeof row === 'object') {
        const first = Object.values(row as Record<string, unknown>)[0];
        return typeof first === 'string' ? first : String(first);
      }
      return String(row);
    });
    if (!hasInsertGrant(grants, opts.database)) {
      return { ok: false, message: '当前用户缺少 INSERT 权限，请授予后重试' };
    }
    return { ok: true, message: '连接成功，已具备 INSERT 权限' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `连接测试失败：${message}` };
  } finally {
    if (conn) await conn.end().catch(() => undefined);
  }
}

/** 交互式配置 MySQL 上报；返回值作为进程退出码 */
export async function runMysqlWizard(prompter: Prompter, probe: MysqlProbe): Promise<number> {
  const existing = readGlobalConfig();
  const existingReporter = existing.reporter as ReporterConfig | undefined;
  const defaults = existingReporter && existingReporter.type === 'mysql' && existingReporter.options
    ? existingReporter.options
    : {};
  const defaultHost = typeof defaults.host === 'string' ? defaults.host : undefined;
  const defaultPort = typeof defaults.port === 'number' ? String(defaults.port) : '3306';
  const defaultDatabase = typeof defaults.database === 'string' ? defaults.database : undefined;
  const defaultUser = typeof defaults.user === 'string' ? defaults.user : undefined;
  const existingPassword = typeof defaults.password === 'string' ? defaults.password : undefined;

  const host = await prompter.ask('MySQL 主机', defaultHost);
  if (!host) {
    console.error('host 不能为空');
    return 1;
  }

  let port: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const portInput = await prompter.ask('端口', defaultPort);
    const n = Number(portInput);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) {
      port = n;
      break;
    }
    if (attempt === 1) {
      console.error('端口必须是 1-65535 之间的整数');
      return 1;
    }
  }

  const database = await prompter.ask('数据库名', defaultDatabase);
  if (!database) {
    console.error('database 不能为空');
    return 1;
  }

  const user = await prompter.ask('用户名', defaultUser);
  if (!user) {
    console.error('user 不能为空');
    return 1;
  }

  const passwordInput = await prompter.askSecret('密码（留空沿用已保存的密码）');
  const password = passwordInput === '' ? existingPassword : passwordInput;

  console.log('正在测试连接…');
  const opts: MysqlOptions = { host, port: port as number, user, password, database, connectTimeout: 5000 };
  const result = await testMysql(opts, probe);
  if (result.ok) {
    console.log('连接成功，已具备 INSERT 权限');
  } else {
    console.log(result.message);
    const proceed = await prompter.confirm('仍然保存？[y/N] ');
    if (!proceed) return 1;
  }

  updateGlobalConfig((raw) => {
    raw.reporter = { type: 'mysql', options: { host, port, user, password, database } };
  });
  console.log('已保存到 ~/.aicode/config.json（权限 600）');
  return 0;
}

/** 把全局 reporter 改为 noop，关闭 MySQL 上报 */
export function disableMysql(): void {
  updateGlobalConfig((raw) => {
    raw.reporter = { type: 'noop' };
  });
}

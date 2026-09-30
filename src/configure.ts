import readline from 'node:readline';
import { assertGlobalConfigWritable, readGlobalConfig, updateGlobalConfig, type ReporterConfig } from './config.js';
import type { MysqlOptions } from './reporter/mysql.js';

export interface Prompter {
  ask(question: string, def?: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
  /** 可选：释放底层资源（如 readline 接口），正常结束时调用 */
  close?(): void;
}

/** readline 在 Ctrl+D（EOF）时关闭输入流而不触发 question 的回调；用该错误标记这种情况，供 runMysqlWizard 识别 */
export class WizardEofError extends Error {
  constructor() {
    super('EOF');
  }
}

/**
 * 基于 readline 的交互式 Prompter：ask 展示默认值、空输入回车沿用默认值；askSecret 不回显输入；
 * historySize:0 关闭输入历史，避免密码可通过方向键（↑）从历史记录中被翻出来；
 * Ctrl+C 时打印换行后以 130（128+SIGINT）退出，不写入任何配置。
 */
export function createTtyPrompter(): Prompter {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
  // 有 question 等待回答时非空；rl 在提问期间关闭（Ctrl+D）说明用户想退出，而不是给出了空答案
  let pendingReject: ((err: Error) => void) | null = null;
  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    rl.close();
    process.exit(130);
  });
  rl.on('close', () => {
    const reject = pendingReject;
    pendingReject = null;
    if (reject) {
      process.stdout.write('\n');
      reject(new WizardEofError());
    }
  });
  return {
    ask(question, def) {
      const suffix = def ? `（默认 ${def}）` : '';
      return new Promise((resolve, reject) => {
        pendingReject = reject;
        rl.question(`${question}${suffix}: `, (answer) => {
          pendingReject = null;
          resolve(answer.trim() || def || '');
        });
      });
    },
    askSecret(question) {
      return new Promise((resolve, reject) => {
        pendingReject = reject;
        // 借用 readline 内部的行编辑（支持退格），只是拦截输出以不回显字符；
        // 退格会触发整行重绘（含提示语本身），命中提示语前缀时只重写提示语本身，避免提示语被吞掉/擦除
        const rlInternal = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
        const originalWrite = rlInternal._writeToOutput.bind(rlInternal);
        const promptText = `${question}: `;
        let active = false;
        rlInternal._writeToOutput = (stringToWrite: string) => {
          if (!active) {
            originalWrite(stringToWrite);
            return;
          }
          if (stringToWrite === '\r\n' || stringToWrite === '\n') {
            originalWrite(stringToWrite);
            return;
          }
          if (stringToWrite.startsWith(promptText)) {
            originalWrite(promptText);
            return;
          }
          // 其余重绘（清屏、移动光标、回显字符等）一律吞掉
        };
        rl.question(promptText, (answer) => {
          rlInternal._writeToOutput = originalWrite;
          pendingReject = null;
          resolve(answer);
        });
        active = true;
      });
    },
    confirm(question) {
      return new Promise((resolve, reject) => {
        pendingReject = reject;
        rl.question(question, (answer) => {
          pendingReject = null;
          resolve(/^y(es)?$/i.test(answer.trim()));
        });
      });
    },
    close() {
      rl.close();
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

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * MySQL 的库级授权作用域按 LIKE 模式匹配：未转义的 % / _ 是通配符，`\%`、`\_` 表示字面量。
 * `*` 单独出现表示全局（*.*），直接判定匹配所有库。
 */
function dbScopeMatches(scopeDb: string, database: string): boolean {
  if (scopeDb === '*') return true;
  let pattern = '';
  for (let i = 0; i < scopeDb.length; i++) {
    const c = scopeDb[i];
    if (c === '\\' && i + 1 < scopeDb.length && (scopeDb[i + 1] === '_' || scopeDb[i + 1] === '%' || scopeDb[i + 1] === '\\')) {
      pattern += escapeRegExp(scopeDb[i + 1]);
      i++;
    } else if (c === '%') {
      pattern += '.*';
    } else if (c === '_') {
      pattern += '.';
    } else {
      pattern += escapeRegExp(c);
    }
  }
  return new RegExp(`^${pattern}$`, 'i').test(database);
}

/**
 * 判断 SHOW GRANTS 的结果是否已具备写入所需的 INSERT 权限：
 * 全局 / 库级 ALL PRIVILEGES 或 INSERT 均视为满足；否则要求对三张目标表分别持有（表级，非列级）INSERT。
 * 列级授权如 `INSERT (col)` 不满足要求，因为不保证能写入全部所需列。
 */
export function hasInsertGrant(grants: string[], database: string): boolean {
  const tablesWithInsert = new Set<string>();
  for (const line of grants) {
    const m = /GRANT\s+(.+?)\s+ON\s+(\S+)\s+TO\b/i.exec(line);
    if (!m) continue;
    const privs = m[1].toUpperCase();
    const { db, table } = parseScope(m[2]);
    if (!dbScopeMatches(db, database)) continue;
    const isAll = /\bALL PRIVILEGES\b/.test(privs) || /(^|,)\s*ALL\s*(,|$)/.test(privs);
    // 列级 INSERT（如 "INSERT (col1, col2)"）不算表级 INSERT：INSERT 后紧跟 "(" 时排除
    const hasInsert = /\bINSERT\b(?!\s*\()/.test(privs);
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
  // 与 updateGlobalConfig 用同一严格校验：配置已损坏时先失败退出，不问任何问题、不尝试写入
  try {
    assertGlobalConfigWritable();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

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
  // 与内置 MySQL Reporter（resolveMysqlOptions）同样的优先级：设置了该环境变量时，上报永远用它，配置文件里的密码不生效；
  // 空字符串视为未设置（用户可能只是 export 了一个空变量），否则会用空密码去测试连接、覆盖已保存的密码
  const rawEnvPassword = process.env.AICODE_MYSQL_PASSWORD;
  const envPassword = rawEnvPassword && rawEnvPassword.length > 0 ? rawEnvPassword : undefined;
  if (envPassword) console.log('检测到环境变量 AICODE_MYSQL_PASSWORD，上报时将优先使用它');

  try {
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

    // 设置了环境变量密码时不再询问，直接沿用（或没有）已保存的密码写回配置，用环境变量的值做连接测试
    let password = existingPassword;
    if (!envPassword) {
      const passwordQuestion = existingPassword ? '密码（留空沿用已保存的密码）' : '密码';
      const passwordInput = await prompter.askSecret(passwordQuestion);
      password = passwordInput === '' ? existingPassword : passwordInput;
    }

    console.log('正在测试连接…');
    const opts: MysqlOptions = { host, port: port as number, user, password: envPassword ?? password, database, connectTimeout: 5000 };
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
  } catch (err) {
    if (err instanceof WizardEofError) return 1; // 已在 prompter 里打印换行，这里不再多输出
    throw err;
  }
}

/**
 * 把全局 reporter 改为 noop，关闭上报；已经是 noop 时不写入（返回提示，调用方据此打印）。
 * 返回值区分原状态：mysql / 其他非 noop 类型 / 本就是 noop。
 */
export function disableMysql(): string {
  // 与 updateGlobalConfig 用同一严格校验：配置已损坏时先抛错，绝不能落到"当前未启用上报"这类误导性提示上
  assertGlobalConfigWritable();
  const existing = readGlobalConfig();
  const existingReporter = existing.reporter as ReporterConfig | undefined;
  const type = existingReporter?.type ?? 'noop';
  if (type === 'noop') return '当前未启用上报';
  updateGlobalConfig((raw) => {
    raw.reporter = { type: 'noop' };
  });
  return type === 'mysql' ? '已关闭 MySQL 上报' : `已关闭上报（原 type=${type}）`;
}

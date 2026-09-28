import { createHash } from 'node:crypto';
import type { CommitEvent } from '../events.js';
import { repoKey } from '../git.js';
import type { Reporter } from './index.js';

export interface MysqlOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  connectTimeout: number;
}

/** 只声明用到的方法，便于测试注入假连接 */
export interface SqlConnection {
  beginTransaction(): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
  execute(sql: string, params: unknown[]): Promise<unknown>;
  end(): Promise<unknown>;
}
export type ConnectionFactory = (opts: MysqlOptions) => Promise<SqlConnection>;

// 只用 INSERT IGNORE：重复上报幂等，且客户端账号只需 INSERT 权限
export const INSERT_COMMIT_SQL =
  'INSERT IGNORE INTO ai_commit (repo_key, commit_sha, repo, branch, parent_sha, commit_message, committed_at, amend, ' +
  'owner_name, owner_email, module, added_total, added_ai, added_human, deleted_total, ai_ratio, ai_generated, ' +
  'ai_accept_rate, client_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
export const INSERT_FILE_SQL =
  'INSERT IGNORE INTO ai_commit_file (repo_key, commit_sha, path_sha1, path, module, added, ai) VALUES (?, ?, ?, ?, ?, ?, ?)';
export const INSERT_TOOL_SQL =
  'INSERT IGNORE INTO ai_commit_tool (repo_key, commit_sha, tool, model, ai, generated) VALUES (?, ?, ?, ?, ?, ?)';

export function toMysqlDatetime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
}

export function resolveMysqlOptions(options: Record<string, unknown>): MysqlOptions {
  const { host, user, database, port, password } = options;
  if (typeof host !== 'string' || typeof user !== 'string' || typeof database !== 'string') {
    throw new Error('mysql reporter 需要配置 host、user、database');
  }
  return {
    host,
    user,
    database,
    port: typeof port === 'number' ? port : 3306,
    password: process.env.AICODE_MYSQL_PASSWORD ?? (typeof password === 'string' ? password : undefined),
    connectTimeout: 5000,
  };
}

const defaultFactory: ConnectionFactory = async (o) => {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({ ...o, charset: 'utf8mb4' });
  return conn as unknown as SqlConnection;
};

export function createMysqlReporter(options: Record<string, unknown>, factory: ConnectionFactory = defaultFactory): Reporter {
  const opts = resolveMysqlOptions(options);
  let conn: SqlConnection | null = null;
  return {
    name: 'mysql',
    async report(e: CommitEvent) {
      conn ??= await factory(opts);
      const key = repoKey(e.repo);
      const s = e.stats;
      await conn.beginTransaction();
      try {
        await conn.execute(INSERT_COMMIT_SQL, [
          key, e.commit_sha, e.repo, e.branch, e.parent_sha, e.commit_message, toMysqlDatetime(e.committed_at),
          e.amend ? 1 : 0, e.owner.name, e.owner.email, e.module, s.added_total, s.added_ai, s.added_human,
          s.deleted_total, s.ai_ratio, s.ai_generated, s.ai_accept_rate, e.client_version,
        ]);
        for (const f of e.files) {
          const pathSha1 = createHash('sha1').update(f.path).digest('hex');
          await conn.execute(INSERT_FILE_SQL, [key, e.commit_sha, pathSha1, f.path, f.module, f.added, f.ai]);
        }
        for (const [toolModel, t] of Object.entries(s.by_tool)) {
          const slash = toolModel.indexOf('/');
          await conn.execute(INSERT_TOOL_SQL, [key, e.commit_sha, toolModel.slice(0, slash), toolModel.slice(slash + 1), t.ai, t.generated]);
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback().catch(() => undefined);
        throw err;
      }
    },
    async close() {
      if (conn) {
        await conn.end();
        conn = null;
      }
    },
  };
}

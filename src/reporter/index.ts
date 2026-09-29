import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ReporterConfig } from '../config.js';
import { markReported, readUnreported, type CommitEvent } from '../events.js';
import { logError } from '../log.js';

export interface Reporter {
  name: string;
  report(event: CommitEvent): Promise<void>;
  /** 可选：释放连接等资源，flushEvents 结束时调用 */
  close?(): Promise<void>;
}

export const noopReporter: Reporter = {
  name: 'noop',
  async report() {
    // 默认空实现：不上报
  },
};

/** type=mysql 时动态加载 MySQL 实现；type=module 时加载自定义模块，其默认导出为 (options) => Reporter */
export async function loadReporter(cfg: ReporterConfig): Promise<Reporter> {
  if (cfg.type === 'mysql') {
    const { createMysqlReporter } = await import('./mysql.js');
    return createMysqlReporter(cfg.options ?? {});
  }
  if (cfg.type !== 'module') return noopReporter;
  if (!cfg.module) {
    logError('reporter', new Error('type=module 时缺少 module 字段'));
    return noopReporter;
  }
  if (!path.isAbsolute(cfg.module)) {
    logError('reporter', new Error(`type=module 的 module 必须是绝对路径: ${cfg.module}`));
    return noopReporter;
  }
  const mod = (await import(/* @vite-ignore */ pathToFileURL(cfg.module).href)) as {
    default: (options: Record<string, unknown>) => Reporter;
  };
  return mod.default(cfg.options ?? {});
}

export interface FlushResult { sent: number; failed: boolean; error?: string }

/**
 * 把任意 err 转成非空的错误描述：优先 message，其次 code（如 ECONNREFUSED），再退到 name，
 * 最后兜底 String(err)。部分错误（如 Node 20 双栈 localhost 触发的 AggregateError）message 为空字符串，
 * 不做兜底会导致 CLI/status 把失败误判成"无错误"。
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return err.message || code || err.name || String(err);
  }
  return String(err) || '未知错误';
}

/** 按顺序补发未上报事件；遇到失败即停止，保证不乱序；结束时关闭 reporter */
export async function flushEvents(reporter: Reporter, limit = 50): Promise<FlushResult> {
  let sent = 0;
  let failed = false;
  let error: string | undefined;
  try {
    for (const event of readUnreported(limit)) {
      if (typeof event.event_id !== 'string' || !event.event_id) {
        // 事件缺少合法 event_id：既无法上报也无法标记已上报，跳过它（不计入 sent），
        // 避免污染真实事件的顺序，也避免它被无限重试
        logError(`report ${reporter.name}`, new Error('事件缺少合法 event_id，已跳过'));
        continue;
      }
      try {
        await reporter.report(event);
        markReported(event.event_id);
        sent++;
      } catch (err) {
        logError(`report ${reporter.name}`, err);
        failed = true;
        error = describeError(err);
        break;
      }
    }
  } finally {
    await reporter.close?.().catch((err) => logError(`close ${reporter.name}`, err));
  }
  return { sent, failed, error };
}

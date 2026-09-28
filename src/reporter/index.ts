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
  if (cfg.type !== 'module' || !cfg.module) return noopReporter;
  const mod = (await import(/* @vite-ignore */ pathToFileURL(cfg.module).href)) as {
    default: (options: Record<string, unknown>) => Reporter;
  };
  return mod.default(cfg.options ?? {});
}

/** 按顺序补发未上报事件；遇到失败即停止，保证不乱序；结束时关闭 reporter */
export async function flushEvents(reporter: Reporter, limit = 50): Promise<void> {
  try {
    for (const event of readUnreported(limit)) {
      try {
        await reporter.report(event);
        markReported(event.event_id);
      } catch (err) {
        logError(`report ${reporter.name}`, err);
        return;
      }
    }
  } finally {
    await reporter.close?.().catch((err) => logError(`close ${reporter.name}`, err));
  }
}

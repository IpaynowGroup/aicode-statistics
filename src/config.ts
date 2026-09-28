import fs from 'node:fs';
import path from 'node:path';
import { logError } from './log.js';
import { configPath } from './paths.js';

export interface ModuleRule { path: string; name: string }
export interface ReporterConfig { type: 'noop' | 'module'; module?: string; options?: Record<string, unknown> }
export interface AicodeConfig {
  owner?: { name?: string; email?: string };
  modules: ModuleRule[];
  ignore: string[];
  reporter: ReporterConfig;
}

function readJson(file: string): Partial<AicodeConfig> {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AicodeConfig>;
  } catch (err) {
    logError(`config ${file}`, err);
    return {};
  }
}

/** 仓库级 .aicode.json 只能覆盖 owner/modules/ignore；reporter 只认全局配置，防止恶意仓库执行代码 */
export function loadConfig(repoRoot: string | null): AicodeConfig {
  const global = readJson(configPath());
  const local = repoRoot ? readJson(path.join(repoRoot, '.aicode.json')) : {};
  return {
    owner: local.owner ?? global.owner,
    modules: local.modules ?? global.modules ?? [],
    ignore: local.ignore ?? global.ignore ?? [],
    reporter: global.reporter ?? { type: 'noop' },
  };
}

export function writeDefaultConfig(): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const cfg: AicodeConfig = { modules: [], ignore: [], reporter: { type: 'noop' } };
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

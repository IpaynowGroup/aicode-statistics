import fs from 'node:fs';
import path from 'node:path';
import { logError } from './log.js';
import { configPath } from './paths.js';

export interface ModuleRule { path: string; name: string }
export interface ReporterConfig { type: 'noop' | 'module' | 'mysql'; module?: string; options?: Record<string, unknown> }
export interface AicodeConfig {
  owner?: { name?: string; email?: string };
  modules: ModuleRule[];
  ignore: string[];
  reporter: ReporterConfig;
}

function readJson(file: string): Partial<AicodeConfig> {
  if (!fs.existsSync(file)) return {};
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    logError(`config ${file}`, err);
    return {};
  }
  const out: Partial<AicodeConfig> = {};
  if (raw.owner !== undefined) {
    if (raw.owner && typeof raw.owner === 'object' && !Array.isArray(raw.owner)) out.owner = raw.owner as AicodeConfig['owner'];
    else logError(`config ${file}`, new Error('owner 字段类型错误（应为对象），已忽略'));
  }
  if (raw.modules !== undefined) {
    if (Array.isArray(raw.modules)) out.modules = raw.modules as ModuleRule[];
    else logError(`config ${file}`, new Error('modules 字段类型错误（应为数组），已忽略'));
  }
  if (raw.ignore !== undefined) {
    if (Array.isArray(raw.ignore)) out.ignore = raw.ignore as string[];
    else logError(`config ${file}`, new Error('ignore 字段类型错误（应为数组），已忽略'));
  }
  if (raw.reporter !== undefined) out.reporter = raw.reporter as ReporterConfig;
  return out;
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

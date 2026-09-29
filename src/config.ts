import fs from 'node:fs';
import path from 'node:path';
import { logError } from './log.js';
import { configPath } from './paths.js';

export interface ModuleRule { path: string; name: string }
export interface ReporterConfig { type: 'noop' | 'module' | 'mysql'; module?: string; options?: Record<string, unknown> }
export interface TrackConfig { mode: 'all' | 'list'; repos: string[] }
export interface AicodeConfig {
  owner?: { name?: string; email?: string };
  modules: ModuleRule[];
  ignore: string[];
  reporter: ReporterConfig;
  track: TrackConfig;
}

const DEFAULT_TRACK: TrackConfig = { mode: 'all', repos: [] };

function isTrackConfig(v: unknown): v is TrackConfig {
  return (
    !!v && typeof v === 'object' && !Array.isArray(v)
    && ((v as TrackConfig).mode === 'all' || (v as TrackConfig).mode === 'list')
    && Array.isArray((v as TrackConfig).repos) && (v as TrackConfig).repos.every((r) => typeof r === 'string')
  );
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
  if (raw.track !== undefined) {
    if (isTrackConfig(raw.track)) out.track = raw.track;
    else logError(`config ${file}`, new Error('track 字段类型错误，已使用默认值'));
  }
  return out;
}

/** 仓库级 .aicode.json 只能覆盖 owner/modules/ignore；reporter、track 只认全局配置，防止恶意仓库执行代码或篡改统计名单 */
export function loadConfig(repoRoot: string | null): AicodeConfig {
  const global = readJson(configPath());
  const local = repoRoot ? readJson(path.join(repoRoot, '.aicode.json')) : {};
  return {
    owner: local.owner ?? global.owner,
    modules: local.modules ?? global.modules ?? [],
    ignore: local.ignore ?? global.ignore ?? [],
    reporter: global.reporter ?? { type: 'noop' },
    track: global.track ?? DEFAULT_TRACK,
  };
}

export function writeDefaultConfig(): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const cfg: AicodeConfig = { modules: [], ignore: [], reporter: { type: 'noop' }, track: DEFAULT_TRACK };
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

/** 原样读取全局配置（未知字段照样保留）；文件不存在或损坏时返回空对象 */
export function readGlobalConfig(): Record<string, unknown> {
  const file = configPath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    logError(`config ${file}`, err);
    return {};
  }
}

/** 读→改→写全局配置，保留未知字段；确保 ~/.aicode 目录权限 700、配置文件权限 600 */
export function updateGlobalConfig(mutate: (raw: Record<string, unknown>) => void): void {
  const file = configPath();
  const raw = readGlobalConfig();
  mutate(raw);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.chmodSync(path.dirname(file), 0o700);
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  fs.chmodSync(file, 0o600);
}

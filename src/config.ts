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

/** 每次调用返回全新对象，避免调用方拿到共享的可变默认值后修改污染后续调用 */
export function defaultTrack(): TrackConfig {
  return { mode: 'all', repos: [] };
}

export function isTrackConfig(v: unknown): v is TrackConfig {
  return (
    !!v && typeof v === 'object' && !Array.isArray(v)
    && ((v as TrackConfig).mode === 'all' || (v as TrackConfig).mode === 'list')
    && Array.isArray((v as TrackConfig).repos) && (v as TrackConfig).repos.every((r) => typeof r === 'string')
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function readJson(file: string): Partial<AicodeConfig> {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logError(`config ${file}`, err);
    return {};
  }
  if (!isPlainObject(parsed)) {
    logError(`config ${file}`, new Error('顶层不是对象，已忽略该文件'));
    return {};
  }
  const raw = parsed;
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
    track: global.track ?? defaultTrack(),
  };
}

export function writeDefaultConfig(): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const cfg: AicodeConfig = { modules: [], ignore: [], reporter: { type: 'noop' }, track: defaultTrack() };
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

/** 原样读取全局配置（未知字段照样保留）；文件不存在、损坏或解析结果不是普通对象时返回空对象，供只读路径（钩子、isRepoTracked、loadConfig）安全使用 */
export function readGlobalConfig(): Record<string, unknown> {
  const file = configPath();
  if (!fs.existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(raw) ? raw : {};
  } catch (err) {
    logError(`config ${file}`, err);
    return {};
  }
}

/** 严格解析全局配置：文件存在但损坏或不是普通对象时抛错，绝不允许写路径把它当空对象覆盖（会丢失 reporter/密码等字段） */
function parseGlobalConfigStrict(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`全局配置 ${file} 解析失败，请先修复后再试`);
  }
  if (!isPlainObject(raw)) throw new Error(`全局配置 ${file} 解析失败，请先修复后再试`);
  return raw;
}

/** 仅校验全局配置可被安全解析，不做任何写入；供 init --local 等场景提前失败，避免走到一半才因配置损坏中止 */
export function assertGlobalConfigWritable(): void {
  parseGlobalConfigStrict(configPath());
}

/**
 * 读→改→写全局配置，保留未知字段；确保 ~/.aicode 目录权限 700、配置文件权限 600。
 * 若现有文件损坏或不是普通对象，直接抛错并放弃写入（不调用 mutate），避免静默覆盖用户配置（如 reporter 密码）。
 * 写入采用临时文件 + rename 的方式保证原子性。
 */
export function updateGlobalConfig(mutate: (raw: Record<string, unknown>) => void): void {
  const file = configPath();
  const raw = parseGlobalConfigStrict(file);
  mutate(raw);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

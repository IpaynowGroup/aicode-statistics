import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { codexHome } from '../paths.js';
import { aicodeCommand } from './shell.js';

const BEGIN = '# >>> aicode hooks >>>';
const END = '# <<< aicode hooks <<<';
const FEATURE_LINE = 'hooks = true # aicode';

/** 与 Codex 一致：sha256(按 key 排序的紧凑 JSON)，handler 带默认值 async=false、timeout=600 */
export function codexTrustHash(eventSnake: string, command: string): string {
  const identity = { event_name: eventSnake, hooks: [{ async: false, command, timeout: 600, type: 'command' }] };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function removeCodexInstall(text: string): string {
  return text
    .replace(new RegExp(`\\n${escapeRe(BEGIN)}\\n[\\s\\S]*?\\n${escapeRe(END)}\\n`, 'g'), '')
    .replace(new RegExp(`^${escapeRe(FEATURE_LINE)}\\n`, 'm'), '');
}

function countGroups(text: string, event: string): number {
  return (text.match(new RegExp(`^\\[\\[hooks\\.${event}\\]\\]`, 'gm')) ?? []).length;
}

function trustLines(configPath: string, preCmd: string, postCmd: string, indexes: [number, number]): string[] {
  const entries = [['pre_tool_use', preCmd, indexes[0]], ['post_tool_use', postCmd, indexes[1]]] as const;
  return entries.flatMap(([snake, cmd, idx]) => [
    `[hooks.state.${JSON.stringify(`${configPath}:${snake}:${idx}:0`)}]`,
    'enabled = true',
    `trusted_hash = ${JSON.stringify(codexTrustHash(snake, cmd))}`,
    '',
  ]);
}

/** aicode 追加的钩子分组在该文件中的下标（按去掉 aicode 区块后已有的分组数计算） */
export function codexGroupIndexes(text: string): [number, number] {
  const stripped = removeCodexInstall(text);
  return [countGroups(stripped, 'PreToolUse'), countGroups(stripped, 'PostToolUse')];
}

/**
 * 以最小文本改动写入：features 开关 + 追加标记区块（钩子分组，以及 withTrust 时的信任记录）。
 * 项目模式传 withTrust=false：Codex 不接受仓库自身文件中的信任记录，改由 applyCodexTrust 写入全局文件。
 */
export function applyCodexInstall(original: string, configPath: string, preCmd: string, postCmd: string, withTrust = true): string {
  let text = removeCodexInstall(original);
  if (text.length && !text.endsWith('\n')) text += '\n';
  const block: string[] = [BEGIN];

  const features = /^\[features\][ \t]*(#.*)?$/m.exec(text);
  if (!features) {
    block.push('[features]', 'hooks = true', '');
  } else {
    const start = features.index + features[0].length;
    const next = text.slice(start).search(/^\[/m);
    const end = next === -1 ? text.length : start + next;
    const section = text.slice(start, end);
    if (!/^hooks\s*=\s*true\b/m.test(section)) {
      const updated = /^hooks\s*=.*$/m.test(section)
        ? section.replace(/^hooks\s*=.*$/m, FEATURE_LINE)
        : `\n${FEATURE_LINE}${section}`;
      text = text.slice(0, start) + updated + text.slice(end);
    }
  }

  const indexes = codexGroupIndexes(text);
  for (const [event, cmd] of [['PreToolUse', preCmd], ['PostToolUse', postCmd]] as const) {
    block.push(`[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${JSON.stringify(cmd)}`, '');
  }
  if (withTrust) block.push(...trustLines(configPath, preCmd, postCmd, indexes));
  block.push(END);
  return `${text}\n${block.join('\n')}\n`;
}

const trustBegin = (p: string): string => `# >>> aicode trust ${p} >>>`;
const trustEnd = (p: string): string => `# <<< aicode trust ${p} <<<`;

export function removeCodexTrust(text: string, projectConfigPath: string): string {
  const re = new RegExp(`\\n${escapeRe(trustBegin(projectConfigPath))}\\n[\\s\\S]*?\\n${escapeRe(trustEnd(projectConfigPath))}\\n`, 'g');
  return text.replace(re, '');
}

/** 在全局配置中追加（或替换）某个项目的信任区块 */
export function applyCodexTrust(
  original: string,
  projectConfigPath: string,
  preCmd: string,
  postCmd: string,
  indexes: [number, number],
): string {
  let text = removeCodexTrust(original, projectConfigPath);
  if (text.length && !text.endsWith('\n')) text += '\n';
  const block = [trustBegin(projectConfigPath), ...trustLines(projectConfigPath, preCmd, postCmd, indexes), trustEnd(projectConfigPath)];
  return `${text}\n${block.join('\n')}\n`;
}

function readOrEmpty(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function backupOnce(file: string): void {
  if (!fs.existsSync(file) || fs.existsSync(file + '.aicode.bak')) return;
  // 文件内容已含 aicode 标记（钩子区块或信任区块），说明是本工具自己创建/管理的，不是用户原有文件，无需备份
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(BEGIN) || /# >>> aicode trust /.test(text)) return;
  fs.copyFileSync(file, file + '.aicode.bak');
}

const codexCommands = (): [string, string] => [aicodeCommand('hook pre --tool codex'), aicodeCommand('hook post --tool codex')];

export function installCodex(configFile: string): void {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const text = readOrEmpty(configFile);
  backupOnce(configFile);
  const [pre, post] = codexCommands();
  fs.writeFileSync(configFile, applyCodexInstall(text, configFile, pre, post));
}

/** 项目模式：钩子写入项目配置，信任记录写入全局配置（Codex 只认全局文件中的信任记录） */
export function installProjectCodex(projectConfigFile: string): void {
  const [pre, post] = codexCommands();
  fs.mkdirSync(path.dirname(projectConfigFile), { recursive: true });
  const text = readOrEmpty(projectConfigFile);
  backupOnce(projectConfigFile);
  fs.writeFileSync(projectConfigFile, applyCodexInstall(text, projectConfigFile, pre, post, false));
  const globalFile = path.join(codexHome(), 'config.toml');
  const globalText = readOrEmpty(globalFile);
  backupOnce(globalFile);
  fs.writeFileSync(globalFile, applyCodexTrust(globalText, projectConfigFile, pre, post, codexGroupIndexes(text)));
}

export function uninstallProjectCodex(projectConfigFile: string): void {
  uninstallCodex(projectConfigFile);
  const globalFile = path.join(codexHome(), 'config.toml');
  if (!fs.existsSync(globalFile)) return;
  const original = fs.readFileSync(globalFile, 'utf8');
  const text = removeCodexTrust(original, projectConfigFile);
  if (text === original) return; // 该项目没有信任记录，不做任何改动（见 F5）
  fs.writeFileSync(globalFile, text);
  const bak = globalFile + '.aicode.bak';
  // 该文件可能还被全局钩子或其他项目的信任记录占用，全部清空后备份才不再需要
  if (fs.existsSync(bak) && !text.includes(BEGIN) && !/# >>> aicode trust /.test(text)) fs.unlinkSync(bak);
}

export function uninstallCodex(configFile: string): void {
  if (!fs.existsSync(configFile)) return;
  const original = fs.readFileSync(configFile, 'utf8');
  const text = removeCodexInstall(original);
  if (text === original) return; // 从未被 aicode 安装过：不做任何改动，也不创建/触碰备份（见 F5）
  const bak = configFile + '.aicode.bak';
  // 文件由 aicode 创建（无备份）且已清空时直接删除
  if (text.trim() === '' && !fs.existsSync(bak)) fs.unlinkSync(configFile);
  else fs.writeFileSync(configFile, text);
  // 该文件可能还被某个项目的信任记录占用（见 installProjectCodex），全部清空后共享备份才不再需要（镜像 uninstallProjectCodex 的守卫）
  if (fs.existsSync(bak) && !/# >>> aicode trust /.test(text)) fs.unlinkSync(bak);
}

/** Codex 只为已信任的项目加载项目级 .codex/config.toml */
export function isCodexTrusted(repoRoot: string): boolean {
  const file = path.join(codexHome(), 'config.toml');
  if (!fs.existsSync(file)) return false;
  const header = `^\\[projects\\.${escapeRe(JSON.stringify(repoRoot))}\\][ \\t]*\\n(?:[^\\[\\n].*\\n|\\n)*?trust_level\\s*=\\s*"trusted"`;
  return new RegExp(header, 'm').test(fs.readFileSync(file, 'utf8'));
}

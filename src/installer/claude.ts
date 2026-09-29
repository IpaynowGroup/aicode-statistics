import fs from 'node:fs';
import path from 'node:path';
import { aicodeCommand } from './shell.js';

export const CLAUDE_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
const EVENTS = [['PreToolUse', 'pre'], ['PostToolUse', 'post']] as const;

type HookEntry = { type?: string; command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

export function isAicodeClaudeCommand(cmd: string): boolean {
  return /\bhook (pre|post) --tool claude$/.test(cmd);
}

function readSettings(file: string): Settings {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Settings) : {};
}

function writeSettings(file: string, s: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !fs.existsSync(file + '.aicode.bak')) {
    // 文件内容已含 aicode 钩子，说明是本工具自己创建/管理的，不是用户原有文件，无需备份
    const prev = fs.readFileSync(file, 'utf8');
    if (!/\bhook (pre|post) --tool claude\b/.test(prev)) fs.copyFileSync(file, file + '.aicode.bak');
  }
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
}

function stripAicode(groups: HookGroup[]): HookGroup[] {
  return groups
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isAicodeClaudeCommand(String(h.command ?? ''))) }))
    .filter((g) => g.hooks.length > 0);
}

export function installClaude(settingsFile: string): void {
  const s = readSettings(settingsFile);
  const hooks = (s.hooks ??= {});
  for (const [event, phase] of EVENTS) {
    const groups = stripAicode(hooks[event] ?? []);
    groups.push({ matcher: CLAUDE_MATCHER, hooks: [{ type: 'command', command: aicodeCommand(`hook ${phase} --tool claude`) }] });
    hooks[event] = groups;
  }
  writeSettings(settingsFile, s);
}

export function uninstallClaude(settingsFile: string): void {
  if (!fs.existsSync(settingsFile)) return;
  // 从未被 aicode 安装过：不做任何改动，也不创建/触碰备份（见 F5）
  if (!/\bhook (pre|post) --tool claude\b/.test(fs.readFileSync(settingsFile, 'utf8'))) return;
  const s = readSettings(settingsFile);
  if (s.hooks) {
    for (const [event] of EVENTS) {
      if (!s.hooks[event]) continue;
      const groups = stripAicode(s.hooks[event]);
      if (groups.length) s.hooks[event] = groups;
      else delete s.hooks[event];
    }
    if (Object.keys(s.hooks).length === 0) delete s.hooks;
  }
  const bak = settingsFile + '.aicode.bak';
  // 文件由 aicode 创建（无备份）且已清空时直接删除
  if (Object.keys(s).length === 0 && !fs.existsSync(bak)) fs.unlinkSync(settingsFile);
  else writeSettings(settingsFile, s);
  if (fs.existsSync(bak)) fs.unlinkSync(bak); // 卸载成功，备份不再需要
}

import os from 'node:os';
import path from 'node:path';

// 所有路径都在调用时计算，便于测试通过修改 HOME 隔离
export const aicodeHome = (): string => process.env.AICODE_HOME ?? path.join(os.homedir(), '.aicode');
export const configPath = (): string => path.join(aicodeHome(), 'config.json');
export const ledgerDir = (): string => path.join(aicodeHome(), 'ledger');
export const pendingDir = (): string => path.join(aicodeHome(), 'pending');
export const eventsPath = (): string => path.join(aicodeHome(), 'events.jsonl');
export const reportedPath = (): string => path.join(aicodeHome(), 'events.reported.jsonl');
export const gitHooksDir = (): string => path.join(aicodeHome(), 'git-hooks');
export const logPath = (): string => path.join(aicodeHome(), 'logs', 'aicode.log');
export const installStatePath = (): string => path.join(aicodeHome(), 'install-state.json');
export const claudeSettingsPath = (): string =>
  path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'settings.json');
export const codexHome = (): string => process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');

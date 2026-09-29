import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { installClaude, isAicodeClaudeCommand, uninstallClaude } from '../src/installer/claude.js';
import {
  applyCodexInstall, applyCodexTrust, codexTrustHash, installCodex, installProjectCodex, isCodexTrusted, removeCodexInstall,
  removeCodexTrust, uninstallCodex, uninstallProjectCodex,
} from '../src/installer/codex.js';
import { claudeSettingsPath } from '../src/paths.js';
import { tmpHome } from './helpers.js';

let home: string;
beforeEach(() => {
  home = tmpHome();
});

describe('Claude 安装器', () => {
  it('保留用户原有钩子，可重复安装，卸载后还原', () => {
    const file = claudeSettingsPath();
    const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [userHook] } }));
    installClaude(file);
    installClaude(file);
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(s.model).toBe('opus');
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[0]).toEqual(userHook);
    expect(s.hooks.PreToolUse[1].matcher).toBe('Write|Edit|MultiEdit|NotebookEdit|Bash');
    expect(isAicodeClaudeCommand(s.hooks.PreToolUse[1].hooks[0].command)).toBe(true);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toMatch(/hook post --tool claude$/);
    expect(fs.existsSync(file + '.aicode.bak')).toBe(true);
    uninstallClaude(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ model: 'opus', hooks: { PreToolUse: [userHook] } });
  });

  it('文件不存在时自动创建，卸载时删除', () => {
    const file = path.join(home, 'repo', '.claude', 'settings.local.json');
    installClaude(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PostToolUse).toHaveLength(1);
    uninstallClaude(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('从未安装过时卸载不做任何改动，也不创建备份（见 F5）', () => {
    const file = claudeSettingsPath();
    const original = JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, original);
    uninstallClaude(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(file + '.aicode.bak')).toBe(false);
  });

  it('卸载成功后删除安装时创建的 .aicode.bak', () => {
    const file = claudeSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model: 'opus' }));
    installClaude(file);
    expect(fs.existsSync(file + '.aicode.bak')).toBe(true);
    uninstallClaude(file);
    expect(fs.existsSync(file + '.aicode.bak')).toBe(false);
  });
});

describe('Codex 安装器', () => {
  it('trusted_hash 为规范化 JSON 的 sha256', () => {
    const canonical = '{"event_name":"pre_tool_use","hooks":[{"async":false,"command":"x y","timeout":600,"type":"command"}]}';
    expect(codexTrustHash('pre_tool_use', 'x y')).toBe('sha256:' + createHash('sha256').update(canonical).digest('hex'));
  });

  const userConfig = [
    'model = "gpt-5.6-luna"',
    '',
    '[features]',
    'memories = true',
    '',
    '[[hooks.PreToolUse]]',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    'command = "echo mine"',
    '',
    '[hooks.state]',
    '',
  ].join('\n');

  it('开启 hooks 特性，按已有分组数计算下标，写入信任记录', () => {
    const out = applyCodexInstall(userConfig, '/h/.codex/config.toml', 'PRE', 'POST');
    expect(out).toContain('[features]\nhooks = true # aicode\nmemories = true');
    expect(out).toContain('command = "PRE"');
    expect(out).toContain('[hooks.state."/h/.codex/config.toml:pre_tool_use:1:0"]');
    expect(out).toContain('[hooks.state."/h/.codex/config.toml:post_tool_use:0:0"]');
    expect(out).toContain(`trusted_hash = "${codexTrustHash('post_tool_use', 'POST')}"`);
  });

  it('重复安装幂等，卸载后与原文一致', () => {
    const once = applyCodexInstall(userConfig, '/c', 'PRE', 'POST');
    expect(applyCodexInstall(once, '/c', 'PRE', 'POST')).toBe(once);
    expect(removeCodexInstall(once)).toBe(userConfig);
  });

  it('已有 hooks = true 时不改动；没有 [features] 时在区块内新建', () => {
    const withTrue = '[features]\nhooks = true\n';
    expect(applyCodexInstall(withTrue, '/c', 'A', 'B')).toContain('[features]\nhooks = true\n\n# >>> aicode hooks >>>');
    const bare = 'model = "x"\n';
    const out = applyCodexInstall(bare, '/c', 'A', 'B');
    expect(out).toContain('# >>> aicode hooks >>>\n[features]\nhooks = true\n');
    expect(removeCodexInstall(out)).toBe(bare);
  });

  it('命令中的引号按 TOML 规则转义', () => {
    expect(applyCodexInstall('', '/c', `'/a b/node' 'x"y'`, 'B')).toContain(`command = "'/a b/node' 'x\\"y'"`);
  });

  it('配置文件不存在时创建，卸载时删除；信任记录 key 使用该文件的绝对路径', () => {
    const file = path.join(home, 'repo', '.codex', 'config.toml');
    installCodex(file);
    expect(fs.readFileSync(file, 'utf8')).toContain(`[hooks.state.${JSON.stringify(`${file}:pre_tool_use:0:0`)}]`);
    uninstallCodex(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('isCodexTrusted 读取全局配置中的项目信任级别', () => {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(
      path.join(home, '.codex', 'config.toml'),
      '[projects."/work/a"]\ntrust_level = "trusted"\n\n[projects."/work/b"]\ntrust_level = "untrusted"\n',
    );
    expect(isCodexTrusted('/work/a')).toBe(true);
    expect(isCodexTrusted('/work/b')).toBe(false);
    expect(isCodexTrusted('/work/c')).toBe(false);
  });

  it('withTrust=false 时不写信任记录', () => {
    expect(applyCodexInstall('', '/p', 'A', 'B', false)).not.toContain('[hooks.state.');
  });

  it('applyCodexTrust 按项目区分区块，互不影响', () => {
    const a = applyCodexTrust('x = 1\n', '/a/.codex/config.toml', 'P', 'Q', [0, 0]);
    const ab = applyCodexTrust(a, '/b/.codex/config.toml', 'P', 'Q', [1, 0]);
    expect(ab).toContain('[hooks.state."/b/.codex/config.toml:pre_tool_use:1:0"]');
    expect(ab).toContain(`trusted_hash = "${codexTrustHash('post_tool_use', 'Q')}"`);
    expect(applyCodexTrust(ab, '/b/.codex/config.toml', 'P', 'Q', [1, 0])).toBe(ab);
    expect(removeCodexTrust(ab, '/b/.codex/config.toml')).toBe(a);
    expect(removeCodexTrust(removeCodexTrust(ab, '/a/.codex/config.toml'), '/b/.codex/config.toml')).toBe('x = 1\n');
  });

  it('项目模式：钩子写入项目文件且不含信任记录，信任记录写入全局文件；卸载后两个文件还原', () => {
    const globalFile = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(globalFile));
    const globalOriginal = '[projects."/r"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(globalFile, globalOriginal);
    const projectFile = path.join(home, 'r', '.codex', 'config.toml');
    installProjectCodex(projectFile);
    installProjectCodex(projectFile);
    const project = fs.readFileSync(projectFile, 'utf8');
    expect(project).toContain('[[hooks.PreToolUse]]');
    expect(project).not.toContain('[hooks.state.');
    const global = fs.readFileSync(globalFile, 'utf8');
    expect(global.match(/# >>> aicode trust /g)).toHaveLength(1);
    expect(global).toContain(`[hooks.state.${JSON.stringify(`${projectFile}:pre_tool_use:0:0`)}]`);
    uninstallProjectCodex(projectFile);
    expect(fs.existsSync(projectFile)).toBe(false);
    expect(fs.readFileSync(globalFile, 'utf8')).toBe(globalOriginal);
  });

  it('从未安装过时卸载不做任何改动，也不创建备份（见 F5）', () => {
    const file = path.join(home, 'repo', '.codex', 'config.toml');
    const original = 'model = "x"\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, original);
    uninstallCodex(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(file + '.aicode.bak')).toBe(false);
  });

  it('卸载成功后删除安装时创建的 .aicode.bak', () => {
    const file = path.join(home, 'repo', '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'model = "x"\n');
    installCodex(file);
    expect(fs.existsSync(file + '.aicode.bak')).toBe(true);
    uninstallCodex(file);
    expect(fs.existsSync(file + '.aicode.bak')).toBe(false);
  });

  it('项目模式卸载：全局文件仍有其他信任记录时保留备份，全部清空后才删除', () => {
    const globalFile = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(globalFile));
    fs.writeFileSync(globalFile, '[projects."/r"]\ntrust_level = "trusted"\n');
    const projectFileA = path.join(home, 'a', '.codex', 'config.toml');
    const projectFileB = path.join(home, 'b', '.codex', 'config.toml');
    installProjectCodex(projectFileA);
    installProjectCodex(projectFileB);
    expect(fs.existsSync(globalFile + '.aicode.bak')).toBe(true);

    uninstallProjectCodex(projectFileA);
    expect(fs.existsSync(globalFile + '.aicode.bak')).toBe(true); // 项目 B 的信任记录还在
    uninstallProjectCodex(projectFileB);
    expect(fs.existsSync(globalFile + '.aicode.bak')).toBe(false); // 全部清空后才删除
  });

  it('全局卸载：项目信任记录还在时保留共享备份，全部清空后才删除（见 R3）', () => {
    const globalFile = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });
    fs.writeFileSync(globalFile, 'model = "x"\n'); // 用户原有内容
    installCodex(globalFile); // 全局钩子也装在这份文件里，触发一次备份
    expect(fs.existsSync(globalFile + '.aicode.bak')).toBe(true);

    const projectFile = path.join(home, 'r', '.codex', 'config.toml');
    installProjectCodex(projectFile); // 往同一份全局文件追加项目的信任记录

    uninstallCodex(globalFile); // 直接对全局文件做 aicode 卸载（init.ts 的全局卸载路径）
    const text = fs.readFileSync(globalFile, 'utf8');
    expect(text).not.toContain('# >>> aicode hooks >>>');
    expect(text).toContain('# >>> aicode trust '); // 项目信任记录还在
    expect(fs.existsSync(globalFile + '.aicode.bak')).toBe(true); // 因此不能删备份

    uninstallProjectCodex(projectFile); // 清掉最后的信任记录
    expect(fs.readFileSync(globalFile, 'utf8')).not.toContain('# >>> aicode trust ');
    expect(fs.existsSync(globalFile + '.aicode.bak')).toBe(false); // 全部清空后才删除
  });

  it('backupOnce：文件已含信任记录即视为 aicode 已管理，不再新建备份（见 R3）', () => {
    const globalFile = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });
    // 模拟：此前只通过 installProjectCodex 写过信任记录，从未对全局文件本身装过钩子
    fs.writeFileSync(
      globalFile,
      ['# >>> aicode trust /r/.codex/config.toml >>>', '# <<< aicode trust /r/.codex/config.toml <<<', ''].join('\n'),
    );
    installCodex(globalFile);
    expect(fs.existsSync(globalFile + '.aicode.bak')).toBe(false);
  });
});

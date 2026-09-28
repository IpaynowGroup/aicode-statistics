// scripts/probe-codex-hooks.mjs
// 一次性探针：验证 Codex 钩子的 trusted_hash（全局 / 项目级）、stdin 字段、tool_name，以及钩子能否写入 $HOME。
// 每个场景使用独立的临时 CODEX_HOME（只复制 auth.json）和临时仓库，不会修改 ~/.codex。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const realCodexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const modelLine = (fs.readFileSync(path.join(realCodexHome, 'config.toml'), 'utf8').match(/^model\s*=\s*".*"$/m) ?? [''])[0];
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const trustHash = (eventSnake, command) =>
  'sha256:' +
  crypto
    .createHash('sha256')
    .update(JSON.stringify({ event_name: eventSnake, hooks: [{ async: false, command, timeout: 600, type: 'command' }] }))
    .digest('hex');

/** 钩子分组 + 信任记录；keyPath 为信任记录 key 中使用的配置文件路径 */
function hooksToml(keyPath, cmd) {
  return [
    '[features]',
    'hooks = true',
    '',
    '[[hooks.PreToolUse]]',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    `command = ${JSON.stringify(cmd('pre'))}`,
    '',
    '[[hooks.PostToolUse]]',
    '[[hooks.PostToolUse.hooks]]',
    'type = "command"',
    `command = ${JSON.stringify(cmd('post'))}`,
    '',
    `[hooks.state.${JSON.stringify(`${keyPath}:pre_tool_use:0:0`)}]`,
    'enabled = true',
    `trusted_hash = ${JSON.stringify(trustHash('pre_tool_use', cmd('pre')))}`,
    '',
    `[hooks.state.${JSON.stringify(`${keyPath}:post_tool_use:0:0`)}]`,
    'enabled = true',
    `trusted_hash = ${JSON.stringify(trustHash('post_tool_use', cmd('post')))}`,
    '',
  ].join('\n');
}

function scenario(name, mode) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `codex-probe-${name}-`)));
  const codexHome = path.join(work, 'codex-home');
  const repo = path.join(work, 'repo');
  // 日志放在 $HOME 下，顺便验证钩子是否受沙箱限制
  const log = path.join(os.homedir(), `.aicode-probe-${name}-${Date.now()}.log`);
  fs.mkdirSync(codexHome);
  fs.mkdirSync(repo);
  fs.copyFileSync(path.join(realCodexHome, 'auth.json'), path.join(codexHome, 'auth.json'));
  execFileSync('git', ['init', '-q'], { cwd: repo });

  const logger = path.join(work, 'logger.mjs');
  fs.writeFileSync(
    logger,
    `import fs from 'node:fs';let d='';process.stdin.on('data',c=>d+=c).on('end',()=>fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({phase:process.argv[2], input:d})+'\\n'));`,
  );
  const cmd = (phase) => `${q(process.execPath)} ${q(logger)} ${phase}`;

  const globalConfig = path.join(codexHome, 'config.toml');
  if (mode === 'global') {
    fs.writeFileSync(globalConfig, `${modelLine}\n\n${hooksToml(globalConfig, cmd)}`);
  } else {
    // 项目模式：全局只声明信任该项目，钩子与信任记录都写在项目 .codex/config.toml
    fs.writeFileSync(globalConfig, `${modelLine}\n\n[features]\nhooks = true\n\n[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
    const projectConfig = path.join(repo, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(projectConfig));
    fs.writeFileSync(projectConfig, hooksToml(projectConfig, cmd));
  }

  const r = spawnSync(
    'codex',
    ['exec', '-s', 'workspace-write', '--skip-git-repo-check', '-C', repo,
     '请完成两步：1) 用 apply_patch 新建 a.txt，内容为 hello；2) 用 shell 命令 echo world > b.txt。不要做其他事。'],
    { env: { ...process.env, CODEX_HOME: codexHome }, encoding: 'utf8', timeout: 300_000 },
  );
  console.log(`\n===== 场景 ${name} =====`);
  console.log('codex exit:', r.status);
  if (r.status !== 0 || /trust|review/i.test(String(r.stderr))) console.log(String(r.stderr).slice(-2000));
  console.log('repo files:', fs.readdirSync(repo));
  const entries = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  console.log('hook calls:', entries.length);
  for (const e of entries) {
    let o = {};
    try { o = JSON.parse(e.input); } catch {}
    console.log(e.phase, o.tool_name, Object.keys(o).join(','));
  }
  console.log('first payload:', entries[0]?.input.slice(0, 2000));
  console.log('workdir:', work, 'log:', log);
}

scenario('global', 'global');
scenario('project', 'project');

# aicode：AI 有效代码量统计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个轻量的 Node CLI `aicode`：通过 Claude Code / Codex 的 Pre/PostToolUse 钩子采集 AI 写入的行指纹，在 git `post-commit` 时计算每个 commit 的 AI 有效代码量，写入 `~/.aicode/events.jsonl`，并交给可扩展的 Reporter（默认空实现，内置 MySQL 5.6+ 直连上报）。

**Architecture:** 钩子阶段：pre 记录基线（编辑类记单文件指纹，shell 类记 `git status` 快照），post 做多重集合差，把新增行的指纹追加到按仓库分片的 ledger。commit 阶段：解析 `git show` 的新增行，逐行消费 ledger 中的指纹，得出 AI 行和人工行，补上负责人、模块信息后生成事件。安装器支持两种模式：全局模式（`~/.claude`、`~/.codex`、全局 `core.hooksPath`）和项目模式（仓库内的 `.claude/settings.local.json`、`.codex/config.toml`、`.git/hooks/post-commit`）；两种模式同时安装时，由钩子和 commit 两处的去重保证不会重复计数。

**Tech Stack:** TypeScript 5（编译到 ES2022 / NodeNext ESM）、Node ≥ 18 内置模块、mysql2（唯一运行时依赖，仅 MySQL 上报时动态加载）、vitest（仅开发依赖）、git ≥ 2.15、MySQL ≥ 5.6。

**Spec:** `docs/superpowers/specs/2026-09-24-aicode-stats-design.md`

## Global Constraints

- 运行时依赖只允许 `mysql2` 一项，且只能在 `src/reporter/mysql.ts` 中通过动态 `import()` 加载；其余代码只能使用 `node:*` 内置模块，保证钩子路径不加载任何第三方代码
- 数据库兼容 MySQL 5.6：不使用 JSON 列，索引键长度 ≤ 767 字节；客户端只执行 `INSERT IGNORE`，不建表
- Node ≥ 18；兼容 git 2.15（本机版本），不得使用 `git init -b`、`GIT_CONFIG_GLOBAL` 等更新版本才有的特性
- 所有数据写入 `~/.aicode/`（测试时通过 `HOME` 环境变量隔离）；**不存代码原文**，只存 12 位 sha1 指纹
- `hook` 和 `commit` 子命令任何异常都只写 `~/.aicode/logs/aicode.log`，退出码恒为 0；只有 `init` 允许非 0 退出
- 单个钩子时间预算 2000ms；`git status` 超过 50000 个文件时跳过快照；单个文件超过 1MB 时不计算指纹
- 仓库级 `.aicode.json` 只能覆盖 `owner` / `modules` / `ignore`，`reporter` 只从全局配置读取（其中可能含数据库密码）；`init` 把 `~/.aicode/config.json` 的权限设为 600
- 代码注释和用户提示用中文；commit message 格式为 `<type>: <中文描述>`，并以 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` 结尾
- 直接在 `main` 分支提交（用户明确要求不拆分支）
- `init` 写入任何文件前必须列出改动并经用户确认（`--yes` 可跳过）；非交互环境下没有 `--yes` 时中止；已存在的文件先备份为 `.aicode.bak`
- 实现和测试过程中**不得修改用户真实的 `~/.claude`、`~/.codex` 或全局 git 配置**：测试一律通过 `tmpHome()` 隔离，真机安装只在 Task 15 征得用户同意后进行

## File Structure

```
package.json / tsconfig.json / vitest.config.ts
scripts/probe-codex-hooks.mjs     # Task 1 一次性探针（验证完保留作记录）
src/
  paths.ts          # 所有路径（基于 HOME / AICODE_HOME / CODEX_HOME / CLAUDE_CONFIG_DIR）
  log.ts            # logError
  version.ts        # VERSION 常量
  fingerprint.ts    # 行归一化、指纹、多重集合差
  ignore.ts         # 默认忽略、glob→正则、linguist-generated
  config.ts         # 配置加载与合并
  git.ts            # git 命令封装与 diff 解析
  ledger.ts         # ledger 读写与文件锁
  snapshot.ts       # pre/post 基线、pending 临时文件
  agents/types.ts   # HookInput 等类型
  agents/claude.ts  # Claude 钩子解析、模型识别
  agents/codex.ts   # Codex 钩子解析、模型识别
  hook.ts           # 钩子编排
  analyzer.ts       # diff × ledger → 统计（纯函数）
  metadata.ts       # owner / module
  events.ts         # CommitEvent 读写
  reporter/index.ts # Reporter 接口、noop、module/mysql 加载、补发
  reporter/mysql.ts # MySQL 直连上报（动态加载 mysql2）
  commit.ts         # commit 编排
  installer/shell.ts   # shell 引号与 aicode 命令拼接
  installer/exclude.ts # .git/info/exclude 标记区块
  installer/git.ts     # 全局 hooksPath 转发脚本 / 项目 post-commit
  installer/claude.ts  # Claude settings（全局或项目文件）
  installer/codex.ts   # Codex config.toml（全局或项目文件）、trusted_hash、项目信任检测
  init.ts           # 全局 / 项目模式的安装与卸载计划
  cli.ts            # 入口
sql/schema.sql      # MySQL 5.6+ 建表脚本（由 DBA 执行）
tests/              # 与 src 同名的 *.test.ts，外加 helpers.ts 和 e2e.test.ts
```

---

### Task 1: Codex 钩子真机探针（Spike）

验证 spec 9.3 节和 4.1 节中尚未证实的几点：
1. **全局模式**：Codex 能否识别我们写入的 `trusted_hash`，而不需要用户手动信任
2. **项目模式**：对已信任的项目，写在项目 `.codex/config.toml` 中的钩子能否生效；信任记录写在项目文件里（key 为项目配置文件的绝对路径）是否被识别
3. PostToolUse 的 stdin 包含哪些字段；`apply_patch` 和 shell/exec 分别以什么 `tool_name` 触发钩子
4. 钩子能否写入 `$HOME`，即是否受沙箱限制

探针全程使用临时 `CODEX_HOME` 和临时仓库，**不修改用户真实配置**。每个场景会发起一次真实的 Codex 请求。

**Files:**
- Create: `scripts/probe-codex-hooks.mjs`
- Create: `docs/superpowers/notes/2026-09-24-codex-hooks-probe.md`

- [ ] **Step 1: 编写探针脚本**

```js
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
    ['exec', '--full-auto', '--skip-git-repo-check', '-C', repo,
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
```

- [ ] **Step 2: 运行探针**

Run: `node scripts/probe-codex-hooks.mjs`
Expected：两个场景的 `repo files` 都包含 `a.txt` 和 `b.txt`（项目场景中还有 `.codex`）；`hook calls` ≥ 4；每行打印 `pre|post <tool_name> <字段列表>`。

- [ ] **Step 3: 根据结果决策并记录**

把 Step 2 的完整输出和以下结论写入 `docs/superpowers/notes/2026-09-24-codex-hooks-probe.md`：

| 观察结果 | 结论与后续动作 |
|---|---|
| global 场景的 `hook calls` ≥ 4，且没有 trust/review 提示 | 全局 trusted_hash 算法正确，Task 13 按计划实现 |
| global 场景的 `hook calls` 为 0，stderr 出现 trust/review 字样 | trusted_hash 不匹配。**停止执行，把输出报告给用户**，对照 git-ai 的 `src/mdm/agents/codex.rs` 重新核对 |
| 两个场景的 `hook calls` 都为 0，且没有任何提示 | `codex exec` 模式可能不运行钩子。改用交互模式手动执行一次（`CODEX_HOME=<codexHome> codex -C <repo>`，输入同样的 prompt）；仍然为 0 就停止并报告 |
| global 正常，project 场景的 `hook calls` 为 0 | 项目级信任记录的写法不对（可能需要写进全局文件，或 key 路径不同）。**停止并报告用户**，由用户决定：先只支持全局模式的 Codex，还是继续研究 |
| 日志文件没有生成，但 stderr 有权限错误 | 钩子运行在沙箱内，无法写入 $HOME。停止并报告，需要调整存储位置 |
| 观察到的 `tool_name` 集合 | 如果有 Task 7 `classifyCodexTool` 列表之外的改文件工具名，就加进列表 |
| stdin 中是否有 `tool_use_id`、`transcript_path`、`model` | 缺少 `tool_use_id` 时，Task 8 会关闭"重复触发去重"，并以最后一次 pre 为准；在笔记中注明 |

- [ ] **Step 4: 清理并提交**

```bash
rm -f ~/.aicode-probe-*.log
git add scripts/probe-codex-hooks.mjs docs/superpowers/notes/2026-09-24-codex-hooks-probe.md
git commit -m "chore: 新增 Codex 钩子真机探针及验证记录

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 项目脚手架与行指纹

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/paths.ts`, `src/log.ts`, `src/version.ts`, `src/fingerprint.ts`
- Create: `tests/helpers.ts`, `tests/fingerprint.test.ts`

**Interfaces:**
- Produces:
  - `paths.ts`：`aicodeHome()`、`configPath()`、`ledgerDir()`、`pendingDir()`、`eventsPath()`、`reportedPath()`、`gitHooksDir()`、`logPath()`、`installStatePath()`、`claudeSettingsPath()`、`codexHome()`，全部为 `() => string`
  - `log.ts`：`logError(context: string, err: unknown): void`
  - `version.ts`：`VERSION: string`
  - `fingerprint.ts`：`normalizeLine(line: string): string | null`、`fingerprint(line: string): string | null`、`fingerprintLines(lines: Iterable<string>): string[]`、`fingerprintText(text: string): string[]`、`multisetDiff(after: string[], before: string[]): string[]`
  - `tests/helpers.ts`：`tmpHome(): string`、`initRepo(): string`、`sh(cwd: string, args: string[]): string`、`commitAll(repo: string, msg: string): string`

- [ ] **Step 1: 创建工程文件并安装开发依赖**

`package.json`：
```json
{
  "name": "aicode-stats",
  "version": "0.1.0",
  "description": "统计 Claude Code / Codex 等 AI 编码工具的有效代码量",
  "type": "module",
  "bin": { "aicode": "dist/cli.js" },
  "files": ["dist"],
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "tsc -p tsconfig.json && vitest run"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`：
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`vitest.config.ts`：
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20_000 },
});
```

Run: `npm install`
Expected：生成 `node_modules/` 和 `package-lock.json`，没有报错。

- [ ] **Step 2: 编写基础模块 paths / log / version**

`src/paths.ts`：
```ts
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
```

`src/log.ts`：
```ts
import fs from 'node:fs';
import path from 'node:path';
import { logPath } from './paths.js';

/** 记录错误到本地日志；日志本身失败时静默，绝不抛出 */
export function logError(context: string, err: unknown): void {
  try {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), `${new Date().toISOString()} [${context}] ${detail}\n`);
  } catch {
    // 忽略
  }
}
```

`src/version.ts`：
```ts
export const VERSION = '0.1.0';
```

- [ ] **Step 3: 编写测试辅助函数**

`tests/helpers.ts`：
```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 创建临时 HOME 并切换过去，隔离 ~/.aicode、~/.claude、~/.codex 和 git 全局配置 */
export function tmpHome(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-home-')));
  process.env.HOME = dir;
  delete process.env.AICODE_HOME;
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  return dir;
}

export function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** 创建临时 git 仓库，并配置提交身份（git 2.15 不支持 init -b） */
export function initRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-repo-')));
  sh(dir, ['init', '-q']);
  sh(dir, ['config', 'user.name', 'Tester']);
  sh(dir, ['config', 'user.email', 'tester@example.com']);
  return dir;
}

export function commitAll(repo: string, msg: string): string {
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-q', '-m', msg]);
  return sh(repo, ['rev-parse', 'HEAD']).trim();
}
```

- [ ] **Step 4: 编写 fingerprint 的失败测试**

`tests/fingerprint.test.ts`：
```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprint, fingerprintText, multisetDiff, normalizeLine } from '../src/fingerprint.js';

describe('normalizeLine', () => {
  it('去掉首尾空白', () => expect(normalizeLine('  foo();  ')).toBe('foo();'));
  it('空行返回 null', () => expect(normalizeLine('   \t')).toBeNull());
  it('只含括号分号逗号的行返回 null', () => {
    expect(normalizeLine('  });')).toBeNull();
    expect(normalizeLine('} )')).toBeNull();
    expect(normalizeLine('],')).toBeNull();
  });
});

describe('fingerprint', () => {
  it('是归一化内容 sha1 的前 12 位', () => {
    expect(fingerprint(' a ')).toBe(createHash('sha1').update('a').digest('hex').slice(0, 12));
  });
  it('无效行返回 null', () => expect(fingerprint('')).toBeNull());
});

describe('fingerprintText', () => {
  it('按行切分（兼容 CRLF）并跳过无效行', () => {
    expect(fingerprintText('a\n\n}\nb\r\n')).toEqual([fingerprint('a'), fingerprint('b')]);
  });
});

describe('multisetDiff', () => {
  it('按出现次数做差', () => {
    expect(multisetDiff(['x', 'x', 'y'], ['x'])).toEqual(['x', 'y']);
    expect(multisetDiff(['x'], ['x', 'x'])).toEqual([]);
  });
});
```

- [ ] **Step 5: 运行测试，确认失败**

Run: `npx vitest run tests/fingerprint.test.ts`
Expected: FAIL，提示无法解析 `../src/fingerprint.js`

- [ ] **Step 6: 实现 fingerprint**

`src/fingerprint.ts`：
```ts
import { createHash } from 'node:crypto';

// 只由括号、分号、逗号（及其间空白）组成的行不计入统计
const PUNCT_ONLY = /^[{}()[\];,\s]+$/;

export function normalizeLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '' || PUNCT_ONLY.test(trimmed)) return null;
  return trimmed;
}

export function fingerprint(line: string): string | null {
  const normalized = normalizeLine(line);
  if (normalized === null) return null;
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

export function fingerprintLines(lines: Iterable<string>): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const fp = fingerprint(line);
    if (fp !== null) out.push(fp);
  }
  return out;
}

export function fingerprintText(text: string): string[] {
  return fingerprintLines(text.split(/\r?\n/));
}

/** 多重集合差：after 中比 before 多出的元素（按出现次数） */
export function multisetDiff(after: string[], before: string[]): string[] {
  const counts = new Map<string, number>();
  for (const fp of before) counts.set(fp, (counts.get(fp) ?? 0) + 1);
  const out: string[] = [];
  for (const fp of after) {
    const c = counts.get(fp) ?? 0;
    if (c > 0) counts.set(fp, c - 1);
    else out.push(fp);
  }
  return out;
}
```

- [ ] **Step 7: 运行测试和类型检查，确认通过**

Run: `npx vitest run tests/fingerprint.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: 全部 PASS，tsc 无输出

- [ ] **Step 8: 提交**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src tests
git commit -m "feat: 初始化工程并实现行指纹与多重集合差

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 忽略规则与配置加载

**Files:**
- Create: `src/ignore.ts`, `src/config.ts`
- Test: `tests/ignore.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: `configPath()`（paths.ts）、`logError`（log.ts）
- Produces:
  - `ignore.ts`：`type IgnoreFn = (rel: string) => boolean`、`DEFAULT_IGNORE: string[]`、`globToRegExp(glob: string): RegExp`、`parseLinguistGenerated(content: string): string[]`、`buildIgnore(repoRoot: string | null, extra: string[]): IgnoreFn`
  - `config.ts`：`interface ModuleRule { path: string; name: string }`、`interface ReporterConfig { type: 'noop' | 'module'; module?: string; options?: Record<string, unknown> }`、`interface AicodeConfig { owner?: { name?: string; email?: string }; modules: ModuleRule[]; ignore: string[]; reporter: ReporterConfig }`、`loadConfig(repoRoot: string | null): AicodeConfig`、`writeDefaultConfig(): void`

- [ ] **Step 1: 编写失败测试**

`tests/ignore.test.ts`：
```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIgnore, globToRegExp, parseLinguistGenerated } from '../src/ignore.js';
import { initRepo } from './helpers.js';

describe('globToRegExp', () => {
  const m = (g: string, p: string) => globToRegExp(g).test(p);
  it('不含 / 的模式匹配任意层级的文件名', () => {
    expect(m('*.lock', 'a/b/yarn.lock')).toBe(true);
    expect(m('Cargo.lock', 'x/Cargo.lock')).toBe(true);
  });
  it('** 跨目录', () => {
    expect(m('**/vendor/**', 'vendor/x.go')).toBe(true);
    expect(m('**/vendor/**', 'a/vendor/x.go')).toBe(true);
    expect(m('src/user/**', 'src/user/a/b.ts')).toBe(true);
    expect(m('src/user/**', 'src/order/a.ts')).toBe(false);
  });
  it('* 不跨目录，? 匹配单个字符', () => {
    expect(m('src/*.ts', 'src/a.ts')).toBe(true);
    expect(m('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(m('a?.js', 'ab.js')).toBe(true);
  });
  it('以 / 结尾表示目录', () => expect(m('dist/', 'dist/a.js')).toBe(true));
  it('转义正则特殊字符', () => expect(m('a+b.ts', 'a+b.ts')).toBe(true));
});

describe('parseLinguistGenerated', () => {
  it('只取标记为 linguist-generated 的模式', () => {
    const content = '# c\ngen/** linguist-generated\n*.pb.ts linguist-generated=true\nx.ts -linguist-generated\ny.ts text\n';
    expect(parseLinguistGenerated(content)).toEqual(['gen/**', '*.pb.ts']);
  });
});

describe('buildIgnore', () => {
  it('合并默认规则、linguist-generated 与额外规则', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'gen/** linguist-generated\n');
    const ignored = buildIgnore(repo, ['docs/**']);
    expect(ignored('package-lock.json')).toBe(true);
    expect(ignored('web/node_modules/a.js')).toBe(true);
    expect(ignored('gen/a.ts')).toBe(true);
    expect(ignored('docs/a.md')).toBe(true);
    expect(ignored('src/a.ts')).toBe(false);
  });
});
```

`tests/config.test.ts`：
```ts
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, writeDefaultConfig } from '../src/config.js';
import { configPath } from '../src/paths.js';
import { initRepo, tmpHome } from './helpers.js';

describe('loadConfig', () => {
  beforeEach(() => tmpHome());

  it('没有配置文件时返回默认值', () => {
    expect(loadConfig(null)).toEqual({ owner: undefined, modules: [], ignore: [], reporter: { type: 'noop' } });
  });

  it('仓库配置覆盖 owner/modules/ignore，但不能覆盖 reporter', () => {
    writeDefaultConfig();
    const global = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    global.owner = { name: '全局' };
    global.reporter = { type: 'module', module: '/safe.js' };
    fs.writeFileSync(configPath(), JSON.stringify(global));
    const repo = initRepo();
    fs.writeFileSync(
      path.join(repo, '.aicode.json'),
      JSON.stringify({ owner: { name: '仓库' }, modules: [{ path: 'src/**', name: 'core' }], reporter: { type: 'module', module: '/evil.js' } }),
    );
    const cfg = loadConfig(repo);
    expect(cfg.owner).toEqual({ name: '仓库' });
    expect(cfg.modules).toEqual([{ path: 'src/**', name: 'core' }]);
    expect(cfg.reporter).toEqual({ type: 'module', module: '/safe.js' });
  });

  it('JSON 损坏时忽略该文件', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), '{bad');
    expect(loadConfig(null).reporter).toEqual({ type: 'noop' });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/ignore.test.ts tests/config.test.ts`
Expected: FAIL，提示无法解析模块

- [ ] **Step 3: 实现 ignore.ts**

```ts
import fs from 'node:fs';
import path from 'node:path';

export type IgnoreFn = (rel: string) => boolean;

// 参考 git-ai 的默认忽略列表：锁文件、压缩产物、依赖目录、快照、protobuf 生成代码
export const DEFAULT_IGNORE: string[] = [
  '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'go.sum', 'Gemfile.lock', 'poetry.lock',
  'composer.lock', 'Pipfile.lock', 'shrinkwrap.yaml', '*.generated.*', '*.min.js', '*.min.css', '*.map',
  '**/vendor/**', '**/node_modules/**', '**/__snapshots__/**', '**/*.snap',
  '*.pb.go', '*.pb.h', '*.pb.cc', '*_pb2.py', '*_pb2_grpc.py', '*.pb.swift', '*.pb.dart',
];

/** 支持 **、*、?；不含 / 的模式匹配任意层级文件名；以 / 结尾表示目录 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/^\//, '');
  if (g.endsWith('/')) g += '**';
  if (!g.includes('/')) g = `**/${g}`;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function parseLinguistGenerated(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    if (attrs.some((a) => a === 'linguist-generated' || a === 'linguist-generated=true')) out.push(pattern);
  }
  return out;
}

export function buildIgnore(repoRoot: string | null, extra: string[]): IgnoreFn {
  let linguist: string[] = [];
  if (repoRoot) {
    try {
      linguist = parseLinguistGenerated(fs.readFileSync(path.join(repoRoot, '.gitattributes'), 'utf8'));
    } catch {
      // 没有 .gitattributes
    }
  }
  const patterns = [...DEFAULT_IGNORE, ...linguist, ...extra].map(globToRegExp);
  return (rel) => patterns.some((re) => re.test(rel));
}
```

- [ ] **Step 4: 实现 config.ts**

```ts
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
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run tests/ignore.test.ts tests/config.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/ignore.ts src/config.ts tests/ignore.test.ts tests/config.test.ts
git commit -m "feat: 实现忽略规则与配置加载

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: git 封装与 diff 解析

**Files:**
- Create: `src/git.ts`
- Test: `tests/git.test.ts`

**Interfaces:**
- Produces（`src/git.ts`）：
  - `git(cwd: string, args: string[]): string`（失败抛异常）、`tryGit(cwd: string, args: string[]): string | null`
  - `repoRoot(cwd: string): string | null`、`repoRootForPath(absPath: string): string | null`、`toRepoRelative(root: string, absPath: string): string`
  - `normalizeRemote(url: string): string`、`repoId(root: string): string`、`repoKey(id: string): string`
  - `currentBranch(root: string): string`、`statusPaths(root: string): string[]`、`showFile(root: string, rev: string, rel: string): string | null`
  - `interface CommitInfo { sha: string; parents: string[]; committedAt: string; authorName: string; authorEmail: string; message: string }`、`commitInfo(root: string, rev: string): CommitInfo`
  - `interface FileDiff { path: string; oldPath: string | null; added: string[]; deleted: number; binary: boolean }`、`parseUnifiedDiff(text: string): FileDiff[]`、`commitDiff(root: string, sha: string): FileDiff[]`
  - `isAmend(root: string): boolean`

- [ ] **Step 1: 编写失败测试**

`tests/git.test.ts`：
```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commitDiff, commitInfo, currentBranch, isAmend, normalizeRemote, parseUnifiedDiff, repoId, repoKey,
  repoRoot, repoRootForPath, showFile, statusPaths, toRepoRelative,
} from '../src/git.js';
import { commitAll, initRepo, sh } from './helpers.js';

describe('normalizeRemote', () => {
  it.each([
    ['git@gitlab.example.com:group/proj.git', 'gitlab.example.com/group/proj'],
    ['ssh://git@gitlab.example.com:2222/group/sub/proj.git', 'gitlab.example.com/group/sub/proj'],
    ['https://user@gitlab.example.com/group/proj.git', 'gitlab.example.com/group/proj'],
    ['https://gitlab.example.com/group/proj', 'gitlab.example.com/group/proj'],
  ])('%s', (url, expected) => expect(normalizeRemote(url)).toBe(expected));
});

describe('parseUnifiedDiff', () => {
  it('解析新增、删除、新文件、删除文件、重命名与二进制', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1,2 @@',
      '-old',
      '+new1',
      '+++not header',
      'diff --git a/n.ts b/n.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/n.ts',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n');
    expect(parseUnifiedDiff(text)).toEqual([
      { path: 'src/a.ts', oldPath: null, added: ['new1', '++not header'], deleted: 1, binary: false },
      { path: 'n.ts', oldPath: null, added: ['hello'], deleted: 0, binary: false },
      { path: 'gone.ts', oldPath: null, added: [], deleted: 2, binary: false },
      { path: 'new.ts', oldPath: 'old.ts', added: ['b'], deleted: 1, binary: false },
      { path: 'img.png', oldPath: null, added: [], deleted: 0, binary: true },
    ]);
  });
});

describe('仓库操作', () => {
  it('repoRoot / repoId / repoKey / currentBranch', () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, 'sub'));
    expect(repoRoot(path.join(repo, 'sub'))).toBe(repo);
    expect(repoId(repo)).toBe(`local:${repo}`);
    sh(repo, ['remote', 'add', 'origin', 'git@gitlab.example.com:group/proj.git']);
    expect(repoId(repo)).toBe('gitlab.example.com/group/proj');
    expect(repoKey('gitlab.example.com/group/proj')).toMatch(/^[0-9a-f]{16}$/);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'init');
    sh(repo, ['checkout', '-q', '-b', 'feature/login']);
    expect(currentBranch(repo)).toBe('feature/login');
  });

  it('repoRootForPath / toRepoRelative 支持尚不存在的文件', () => {
    const repo = initRepo();
    const abs = path.join(repo, 'x', 'y', 'z.ts');
    expect(repoRootForPath(abs)).toBe(repo);
    expect(toRepoRelative(repo, abs)).toBe('x/y/z.ts');
    expect(repoRootForPath('/definitely/not/here/a.ts')).toBeNull();
  });

  it('statusPaths 列出改动、未跟踪文件和重命名后的新路径', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'r.txt'), 'r\n');
    commitAll(repo, 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a2\n');
    fs.mkdirSync(path.join(repo, 'd'));
    fs.writeFileSync(path.join(repo, 'd', 'new file.txt'), 'n\n');
    sh(repo, ['mv', 'r.txt', 'r2.txt']);
    expect(statusPaths(repo).sort()).toEqual(['a.txt', 'd/new file.txt', 'r2.txt']);
  });

  it('showFile / commitInfo / commitDiff / isAmend', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\n');
    const sha1 = commitAll(repo, 'feat: 第一次');
    expect(showFile(repo, 'HEAD', 'a.txt')).toBe('line1\n');
    expect(showFile(repo, 'HEAD', 'missing.txt')).toBeNull();
    const info = commitInfo(repo, 'HEAD');
    expect(info).toMatchObject({ sha: sha1, parents: [], authorName: 'Tester', authorEmail: 'tester@example.com', message: 'feat: 第一次' });
    expect(info.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(commitDiff(repo, sha1)).toEqual([{ path: 'a.txt', oldPath: null, added: ['line1'], deleted: 0, binary: false }]);
    expect(isAmend(repo)).toBe(false);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2\n');
    sh(repo, ['commit', '-q', '-a', '--amend', '-m', 'feat: 修改']);
    expect(isAmend(repo)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/git.test.ts`
Expected: FAIL，提示无法解析 `../src/git.js`

- [ ] **Step 3: 实现 git.ts**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string | null {
  const out = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  return out ? out.trim() : null;
}

function nearestExistingDir(absPath: string): string | null {
  let dir = path.dirname(absPath);
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return dir;
}

export function repoRootForPath(absPath: string): string | null {
  const dir = nearestExistingDir(absPath);
  return dir ? repoRoot(dir) : null;
}

/** 转为仓库相对路径（POSIX 分隔符）；先 realpath 已存在的祖先目录，以兼容 /var → /private/var 这类软链 */
export function toRepoRelative(root: string, absPath: string): string {
  const dir = nearestExistingDir(absPath) ?? path.dirname(absPath);
  const rest = path.relative(dir, absPath);
  const real = path.join(fs.realpathSync(dir), rest);
  return path.relative(root, real).split(path.sep).join('/');
}

export function normalizeRemote(url: string): string {
  const u = url.trim().replace(/\.git$/, '');
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(u);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const parsed = new URL(u);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return u;
  }
}

export function repoId(root: string): string {
  const url = tryGit(root, ['config', '--get', 'remote.origin.url'])?.trim();
  return url ? normalizeRemote(url) : `local:${root}`;
}

export function repoKey(id: string): string {
  return createHash('sha1').update(id).digest('hex').slice(0, 16);
}

export function currentBranch(root: string): string {
  return tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() ?? 'HEAD';
}

/** 已改动（含未跟踪）文件的仓库相对路径；重命名只保留新路径 */
export function statusPaths(root: string): string[] {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    paths.push(entry.slice(3));
    if (x === 'R' || x === 'C') i++; // -z 模式下紧跟一个原路径条目
  }
  return paths;
}

export function showFile(root: string, rev: string, rel: string): string | null {
  return tryGit(root, ['show', `${rev}:${rel}`]);
}

export interface CommitInfo {
  sha: string;
  parents: string[];
  committedAt: string;
  authorName: string;
  authorEmail: string;
  message: string;
}

export function commitInfo(root: string, rev: string): CommitInfo {
  const out = git(root, ['log', '-1', '--format=%H%x1f%P%x1f%cI%x1f%an%x1f%ae%x1f%B', rev]);
  const [sha, parents, committedAt, authorName, authorEmail, message] = out.split('\x1f');
  return {
    sha,
    parents: parents.trim() ? parents.trim().split(' ') : [],
    committedAt,
    authorName,
    authorEmail,
    message: message.trim(),
  };
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  added: string[];
  deleted: number;
  binary: boolean;
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { path: '', oldPath: null, added: [], deleted: 0, binary: false };
      files.push(cur);
      inHunk = false;
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m) cur.path = m[2];
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('rename from ')) cur.oldPath = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.path = line.slice('rename to '.length);
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') cur.path = line.slice(4).replace(/^b\//, '');
      else if (line.startsWith('Binary files ')) cur.binary = true;
      continue;
    }
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.deleted++;
  }
  return files;
}

export function commitDiff(root: string, sha: string): FileDiff[] {
  return parseUnifiedDiff(git(root, ['show', '--pretty=format:', '-U0', '--no-color', '--no-ext-diff', '-M', sha]));
}

export function isAmend(root: string): boolean {
  return (tryGit(root, ['reflog', '-1', '--format=%gs']) ?? '').startsWith('commit (amend)');
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/git.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/git.ts tests/git.test.ts
git commit -m "feat: 实现 git 命令封装与 diff 解析

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: ledger 与文件锁

**Files:**
- Create: `src/ledger.ts`
- Test: `tests/ledger.test.ts`

**Interfaces:**
- Consumes: `ledgerDir()`
- Produces: `interface LedgerRecord { p: string; f: string; t: string; m: string; s: string; ts: number }`（ts 为秒）、`ledgerFile(repoKey: string): string`、`withLock<T>(repoKey: string, fn: () => T): T`、`readRecords(repoKey: string): LedgerRecord[]`、`writeRecords(repoKey: string, records: LedgerRecord[]): void`、`appendRecords(repoKey: string, records: LedgerRecord[]): void`（内部加锁，**不得在 withLock 内调用**）

- [ ] **Step 1: 编写失败测试**

`tests/ledger.test.ts`：
```ts
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { appendRecords, ledgerFile, readRecords, withLock, writeRecords, type LedgerRecord } from '../src/ledger.js';
import { tmpHome } from './helpers.js';

const rec = (f: string): LedgerRecord => ({ p: 'a.ts', f, t: 'claude-code', m: 'm', s: 's', ts: 1 });

describe('ledger', () => {
  beforeEach(() => tmpHome());

  it('追加后可读回，文件不存在时为空', () => {
    expect(readRecords('k')).toEqual([]);
    appendRecords('k', [rec('a'), rec('b')]);
    appendRecords('k', [rec('c')]);
    expect(readRecords('k').map((r) => r.f)).toEqual(['a', 'b', 'c']);
  });

  it('writeRecords 整体替换，并跳过损坏的行', () => {
    appendRecords('k', [rec('a')]);
    fs.appendFileSync(ledgerFile('k'), '{broken\n');
    expect(readRecords('k').map((r) => r.f)).toEqual(['a']);
    writeRecords('k', [rec('z')]);
    expect(readRecords('k').map((r) => r.f)).toEqual(['z']);
  });

  it('withLock 执行完释放锁，并能接管超过 10 秒的陈旧锁', () => {
    expect(withLock('k', () => 42)).toBe(42);
    expect(fs.existsSync(ledgerFile('k') + '.lock')).toBe(false);
    fs.mkdirSync(path.dirname(ledgerFile('k')), { recursive: true });
    fs.writeFileSync(ledgerFile('k') + '.lock', '999');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(ledgerFile('k') + '.lock', old, old);
    expect(withLock('k', () => 'ok')).toBe('ok');
  });
});
```


- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/ledger.test.ts`
Expected: FAIL，提示无法解析 `../src/ledger.js`

- [ ] **Step 3: 实现 ledger.ts**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { ledgerDir } from './paths.js';

/** p=仓库相对路径 f=指纹 t=工具 m=模型 s=会话 ts=秒级时间戳 */
export interface LedgerRecord { p: string; f: string; t: string; m: string; s: string; ts: number }

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

export function ledgerFile(repoKey: string): string {
  return path.join(ledgerDir(), `${repoKey}.jsonl`);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLock<T>(repoKey: string, fn: () => T): T {
  const lock = ledgerFile(repoKey) + '.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // 锁刚被释放
      }
      if (Date.now() > deadline) throw new Error(`获取 ledger 锁超时: ${lock}`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // 忽略
    }
  }
}

export function readRecords(repoKey: string): LedgerRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(ledgerFile(repoKey), 'utf8');
  } catch {
    return [];
  }
  const out: LedgerRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as LedgerRecord);
    } catch {
      // 跳过损坏行
    }
  }
  return out;
}

/** 写临时文件后 rename，保证原子替换；调用方须持有锁 */
export function writeRecords(repoKey: string, records: LedgerRecord[]): void {
  const file = ledgerFile(repoKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r) + '\n').join(''));
  fs.renameSync(tmp, file);
}

export function appendRecords(repoKey: string, records: LedgerRecord[]): void {
  if (records.length === 0) return;
  withLock(repoKey, () => {
    fs.appendFileSync(ledgerFile(repoKey), records.map((r) => JSON.stringify(r) + '\n').join(''));
  });
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/ledger.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/ledger.ts tests/ledger.test.ts
git commit -m "feat: 实现 ledger 读写与文件锁

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: pre/post 基线快照

**Files:**
- Create: `src/snapshot.ts`
- Test: `tests/snapshot.test.ts`

**Interfaces:**
- Consumes: `fingerprintText`、`multisetDiff`、`statusPaths`、`showFile`、`IgnoreFn`、`pendingDir()`
- Produces:
  - `MAX_FILE_BYTES = 1048576`、`MAX_STATUS_FILES = 50000`
  - `interface FileState { mtimeMs: number; size: number; fps: string[] | null }`
  - `type EditBaseline = { kind: 'edit'; repoRoot: string; rel: string; fps: string[] }`、`type ShellBaseline = { kind: 'shell'; repoRoot: string; files: Record<string, FileState> }`、`type Baseline = EditBaseline | ShellBaseline`
  - `interface Change { repoRoot: string; rel: string; fps: string[] }`
  - `class BudgetExceeded extends Error`
  - `readFingerprints(absPath: string): string[] | null`（文件不存在返回 `[]`；过大、二进制或不可读返回 `null`）
  - `captureEditBaseline(repoRoot: string, rel: string): EditBaseline | null`、`editChanges(b: EditBaseline): Change[]`
  - `captureShellBaseline(repoRoot: string, isIgnored: IgnoreFn, deadline: number): ShellBaseline | null`、`shellChanges(b: ShellBaseline, isIgnored: IgnoreFn, deadline: number): Change[]`
  - `savePending(key: string, b: Baseline): void`、`takePending(key: string): Baseline | null`（取出后把 pending 文件改名为 `.done` 标记）、`hasPending(key: string): boolean`、`isDone(key: string): boolean`、`cleanupPending(maxAgeMs?: number): void`（同时清理过期的 `.done`）

- [ ] **Step 1: 编写失败测试**

`tests/snapshot.test.ts`：
```ts
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fingerprintText } from '../src/fingerprint.js';
import { buildIgnore } from '../src/ignore.js';
import { pendingDir } from '../src/paths.js';
import {
  BudgetExceeded, captureEditBaseline, captureShellBaseline, cleanupPending, editChanges, MAX_FILE_BYTES,
  hasPending, isDone, readFingerprints, savePending, shellChanges, takePending,
} from '../src/snapshot.js';
import { commitAll, initRepo, tmpHome } from './helpers.js';

const far = () => Date.now() + 60_000;

describe('readFingerprints', () => {
  beforeEach(() => tmpHome());
  it('不存在返回 []，二进制和超大文件返回 null', () => {
    const repo = initRepo();
    expect(readFingerprints(path.join(repo, 'none.ts'))).toEqual([]);
    fs.writeFileSync(path.join(repo, 'bin'), Buffer.from([1, 0, 2]));
    expect(readFingerprints(path.join(repo, 'bin'))).toBeNull();
    fs.writeFileSync(path.join(repo, 'big'), 'a'.repeat(MAX_FILE_BYTES + 1));
    expect(readFingerprints(path.join(repo, 'big'))).toBeNull();
  });
});

describe('编辑类基线', () => {
  beforeEach(() => tmpHome());
  it('只返回新增的行', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.ts'), 'keep\n');
    const b = captureEditBaseline(repo, 'a.ts')!;
    fs.writeFileSync(path.join(repo, 'a.ts'), 'keep\nadded\n');
    expect(editChanges(b)).toEqual([{ repoRoot: repo, rel: 'a.ts', fps: fingerprintText('added') }]);
  });
});

describe('shell 类基线', () => {
  beforeEach(() => tmpHome());
  it('只统计执行期间的变化，排除执行前已有的人工改动和被忽略的文件', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.ts'), 'base\n');
    commitAll(repo, 'init');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'base\nhuman line\n'); // 执行前的人工改动
    const ignored = buildIgnore(repo, []);
    const b = captureShellBaseline(repo, ignored, far())!;
    fs.writeFileSync(path.join(repo, 'a.ts'), 'base\nhuman line\nai line\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'new file line\n');
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"x": 1}\n');
    const changes = shellChanges(b, ignored, far()).sort((x, y) => x.rel.localeCompare(y.rel));
    expect(changes).toEqual([
      { repoRoot: repo, rel: 'a.ts', fps: fingerprintText('ai line') },
      { repoRoot: repo, rel: 'b.ts', fps: fingerprintText('new file line') },
    ]);
  });

  it('执行前未改动的已跟踪文件，以 HEAD 版本为基线', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'c.ts'), 'one\n');
    commitAll(repo, 'init');
    const ignored = buildIgnore(repo, []);
    const b = captureShellBaseline(repo, ignored, far())!;
    fs.writeFileSync(path.join(repo, 'c.ts'), 'one\ntwo\n');
    expect(shellChanges(b, ignored, far())).toEqual([{ repoRoot: repo, rel: 'c.ts', fps: fingerprintText('two') }]);
  });

  it('超出时间预算抛出 BudgetExceeded', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'x.ts'), 'x\n');
    expect(() => captureShellBaseline(repo, buildIgnore(repo, []), Date.now() - 1)).toThrow(BudgetExceeded);
  });
});

describe('pending', () => {
  beforeEach(() => tmpHome());
  it('take 只能取一次并留下 .done 标记；cleanup 清理过期的 pending 与 .done', () => {
    const key = 'claude-code_s/1_t:1';
    savePending(key, { kind: 'edit', repoRoot: '/r', rel: 'a', fps: [] });
    expect(hasPending(key)).toBe(true);
    expect(isDone(key)).toBe(false);
    expect(takePending(key)).toEqual({ kind: 'edit', repoRoot: '/r', rel: 'a', fps: [] });
    expect(takePending(key)).toBeNull();
    expect(hasPending(key)).toBe(false);
    expect(isDone(key)).toBe(true);
    savePending('old', { kind: 'edit', repoRoot: '/r', rel: 'a', fps: [] });
    const old = new Date(Date.now() - 2 * 3600_000);
    for (const name of fs.readdirSync(pendingDir())) fs.utimesSync(path.join(pendingDir(), name), old, old);
    cleanupPending();
    expect(fs.readdirSync(pendingDir())).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/snapshot.test.ts`
Expected: FAIL，提示无法解析 `../src/snapshot.js`

- [ ] **Step 3: 实现 snapshot.ts**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { fingerprintText, multisetDiff } from './fingerprint.js';
import { showFile, statusPaths } from './git.js';
import type { IgnoreFn } from './ignore.js';
import { pendingDir } from './paths.js';

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_STATUS_FILES = 50_000;

export interface FileState { mtimeMs: number; size: number; fps: string[] | null }
export type EditBaseline = { kind: 'edit'; repoRoot: string; rel: string; fps: string[] };
export type ShellBaseline = { kind: 'shell'; repoRoot: string; files: Record<string, FileState> };
export type Baseline = EditBaseline | ShellBaseline;
export interface Change { repoRoot: string; rel: string; fps: string[] }

export class BudgetExceeded extends Error {}

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new BudgetExceeded('钩子超出时间预算');
}

/** 文件不存在返回 []；过大、二进制或不可读返回 null */
export function readFingerprints(absPath: string): string[] | null {
  let buf: Buffer;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    buf = fs.readFileSync(absPath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  if (buf.subarray(0, 8000).includes(0)) return null;
  return fingerprintText(buf.toString('utf8'));
}

function statFile(abs: string): fs.Stats | null {
  try {
    const st = fs.lstatSync(abs);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

export function captureEditBaseline(repoRoot: string, rel: string): EditBaseline | null {
  const fps = readFingerprints(path.join(repoRoot, rel));
  return fps ? { kind: 'edit', repoRoot, rel, fps } : null;
}

export function editChanges(b: EditBaseline): Change[] {
  const after = readFingerprints(path.join(b.repoRoot, b.rel));
  if (!after) return [];
  const fps = multisetDiff(after, b.fps);
  return fps.length ? [{ repoRoot: b.repoRoot, rel: b.rel, fps }] : [];
}

export function captureShellBaseline(repoRoot: string, isIgnored: IgnoreFn, deadline: number): ShellBaseline | null {
  const paths = statusPaths(repoRoot);
  if (paths.length > MAX_STATUS_FILES) return null;
  const files: Record<string, FileState> = {};
  for (const rel of paths) {
    checkDeadline(deadline);
    if (isIgnored(rel)) continue;
    const abs = path.join(repoRoot, rel);
    const st = statFile(abs);
    if (!st) continue;
    files[rel] = { mtimeMs: st.mtimeMs, size: st.size, fps: readFingerprints(abs) };
  }
  return { kind: 'shell', repoRoot, files };
}

export function shellChanges(b: ShellBaseline, isIgnored: IgnoreFn, deadline: number): Change[] {
  const paths = statusPaths(b.repoRoot);
  if (paths.length > MAX_STATUS_FILES) return [];
  const changes: Change[] = [];
  for (const rel of paths) {
    checkDeadline(deadline);
    if (isIgnored(rel)) continue;
    const abs = path.join(b.repoRoot, rel);
    const st = statFile(abs);
    if (!st) continue;
    const prev = b.files[rel];
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
    const after = readFingerprints(abs);
    if (!after) continue;
    // pre 时已改动的文件用 pre 的指纹；否则以 HEAD 版本为基线（新文件为空）
    const before = prev ? prev.fps : fingerprintText(showFile(b.repoRoot, 'HEAD', rel) ?? '');
    if (!before) continue;
    const fps = multisetDiff(after, before);
    if (fps.length) changes.push({ repoRoot: b.repoRoot, rel, fps });
  }
  return changes;
}

function pendingFile(key: string): string {
  return path.join(pendingDir(), `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

export function savePending(key: string, b: Baseline): void {
  fs.mkdirSync(pendingDir(), { recursive: true });
  fs.writeFileSync(pendingFile(key), JSON.stringify(b));
}

function doneFile(key: string): string {
  return pendingFile(key).replace(/\.json$/, '.done');
}

export function hasPending(key: string): boolean {
  return fs.existsSync(pendingFile(key));
}

export function isDone(key: string): boolean {
  return fs.existsSync(doneFile(key));
}

/** 取出基线后改名为 .done，供重复触发的钩子识别"已处理" */
export function takePending(key: string): Baseline | null {
  const file = pendingFile(key);
  try {
    const b = JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
    fs.renameSync(file, doneFile(key));
    return b;
  } catch {
    return null;
  }
}

export function cleanupPending(maxAgeMs = 3600_000): void {
  let names: string[];
  try {
    names = fs.readdirSync(pendingDir());
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const file = path.join(pendingDir(), name);
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.unlinkSync(file);
    } catch {
      // 忽略
    }
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/snapshot.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/snapshot.ts tests/snapshot.test.ts
git commit -m "feat: 实现编辑类与 shell 类工具的 pre/post 基线快照

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Claude / Codex 钩子输入解析与模型识别

**Files:**
- Create: `src/agents/types.ts`, `src/agents/claude.ts`, `src/agents/codex.ts`
- Test: `tests/agents.test.ts`

**Interfaces:**
- Consumes: `codexHome()`
- Produces:
  - `types.ts`：`type Phase = 'pre' | 'post'`、`type ToolClass = 'edit' | 'shell' | 'skip'`、`type AgentName = 'claude-code' | 'codex'`、`interface HookInput { agent: AgentName; toolClass: ToolClass; sessionId: string; toolUseId: string; cwd: string; filePath: string | null; fallbackText: string | null; transcriptPath: string | null; model: string | null }`、`readTail(file: string, bytes: number): string`
  - `claude.ts`：`classifyClaudeTool(name: string): ToolClass`、`parseClaudeHook(raw: unknown): HookInput`、`claudeModelFromTranscript(file: string): string | null`
  - `codex.ts`：`classifyCodexTool(name: string): ToolClass`、`parseCodexHook(raw: unknown): HookInput`、`findCodexRollout(sessionId: string): string | null`、`codexModelFromRollout(file: string): string | null`

说明：已核实 Codex 0.155.1 的模型名在 `turn_context.payload.model`，不在 `session_meta` 中，而且每轮对话都可能更换模型，所以要从日志末尾往前找。**本任务同时修正 spec 4.6 节的对应描述。**

- [ ] **Step 1: 编写失败测试**

`tests/agents.test.ts`：
```ts
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { classifyClaudeTool, claudeModelFromTranscript, parseClaudeHook } from '../src/agents/claude.js';
import { classifyCodexTool, codexModelFromRollout, findCodexRollout, parseCodexHook } from '../src/agents/codex.js';
import { tmpHome } from './helpers.js';

describe('Claude', () => {
  beforeEach(() => tmpHome());

  it('按工具名分类', () => {
    expect(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].map(classifyClaudeTool)).toEqual(['edit', 'edit', 'edit', 'edit']);
    expect(classifyClaudeTool('Bash')).toBe('shell');
    expect(classifyClaudeTool('Read')).toBe('skip');
  });

  it('解析 Edit / MultiEdit / Write 的输入', () => {
    const base = { session_id: 's1', tool_use_id: 't1', cwd: '/repo', transcript_path: '/t.jsonl' };
    expect(parseClaudeHook({ ...base, tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', new_string: 'x' } })).toEqual({
      agent: 'claude-code', toolClass: 'edit', sessionId: 's1', toolUseId: 't1', cwd: '/repo',
      filePath: '/repo/src/a.ts', fallbackText: 'x', transcriptPath: '/t.jsonl', model: null,
    });
    expect(parseClaudeHook({ ...base, tool_name: 'MultiEdit', tool_input: { file_path: '/abs/a.ts', edits: [{ new_string: 'a' }, { new_string: 'b' }] } }).fallbackText).toBe('a\nb');
    expect(parseClaudeHook({ ...base, tool_name: 'Write', tool_input: { file_path: '/abs/a.ts', content: 'c' } }).fallbackText).toBe('c');
    expect(parseClaudeHook({}).sessionId).toBe('unknown');
  });

  it('从 transcript 末尾读取最近一次 assistant 使用的模型', () => {
    const file = path.join(process.env.HOME!, 't.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'assistant', message: { model: 'old-model' } }),
      JSON.stringify({ type: 'user', message: {} }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } }),
      '',
    ].join('\n'));
    expect(claudeModelFromTranscript(file)).toBe('claude-opus-5-5');
    expect(claudeModelFromTranscript('/nope.jsonl')).toBeNull();
  });
});

describe('Codex', () => {
  beforeEach(() => tmpHome());

  it('按工具名分类，并去掉 functions. 前缀', () => {
    expect(['apply_patch', 'exec_command', 'shell', 'shell_command', 'Bash', 'exec', 'functions.exec_command', 'multi_tool_use.parallel'].map(classifyCodexTool))
      .toEqual(Array(8).fill('shell'));
    expect(classifyCodexTool('web_search')).toBe('skip');
  });

  it('解析输入，session_id 缺失时用 thread_id', () => {
    const input = parseCodexHook({ thread_id: 'th1', tool_name: 'exec', cwd: '/repo', model: 'gpt-x' });
    expect(input).toMatchObject({ agent: 'codex', toolClass: 'shell', sessionId: 'th1', toolUseId: 'unknown', model: 'gpt-x', filePath: null });
  });

  it('按 session_id 查找会话日志，并从中读取最近的 turn_context 模型', () => {
    const dir = path.join(process.env.HOME!, '.codex', 'sessions', '2026', '09', '24');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-2026-09-24T10-00-00-abc-123.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'abc-123' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-a' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-b' } }),
      '',
    ].join('\n'));
    expect(findCodexRollout('abc-123')).toBe(file);
    expect(findCodexRollout('zzz')).toBeNull();
    expect(codexModelFromRollout(file)).toBe('gpt-b');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/agents.test.ts`
Expected: FAIL，提示无法解析模块

- [ ] **Step 3: 实现 types.ts**

```ts
import fs from 'node:fs';

export type Phase = 'pre' | 'post';
export type ToolClass = 'edit' | 'shell' | 'skip';
export type AgentName = 'claude-code' | 'codex';

export interface HookInput {
  agent: AgentName;
  toolClass: ToolClass;
  sessionId: string;
  toolUseId: string;
  cwd: string;
  filePath: string | null; // 编辑类工具的目标文件（绝对路径）
  fallbackText: string | null; // 缺少 pre 基线时，退回使用的新写入文本
  transcriptPath: string | null;
  model: string | null;
}

export function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
```

- [ ] **Step 4: 实现 claude.ts**

```ts
import path from 'node:path';
import { readTail, type HookInput, type ToolClass } from './types.js';

export function classifyClaudeTool(name: string): ToolClass {
  switch (name.toLowerCase()) {
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
      return 'edit';
    case 'bash':
      return 'shell';
    default:
      return 'skip';
  }
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function fallbackText(input: Obj): string | null {
  if (typeof input.content === 'string') return input.content;
  if (typeof input.new_string === 'string') return input.new_string;
  if (typeof input.new_source === 'string') return input.new_source;
  if (Array.isArray(input.edits)) return input.edits.map((e) => str((e as Obj)?.new_string) ?? '').join('\n');
  return null;
}

export function parseClaudeHook(raw: unknown): HookInput {
  const data = (raw ?? {}) as Obj;
  const toolInput = (data.tool_input ?? {}) as Obj;
  const cwd = str(data.cwd) ?? process.cwd();
  const file = str(toolInput.file_path) ?? str(toolInput.notebook_path);
  return {
    agent: 'claude-code',
    toolClass: classifyClaudeTool(str(data.tool_name) ?? ''),
    sessionId: str(data.session_id) ?? 'unknown',
    toolUseId: str(data.tool_use_id) ?? 'unknown',
    cwd,
    filePath: file ? path.resolve(cwd, file) : null,
    fallbackText: fallbackText(toolInput),
    transcriptPath: str(data.transcript_path),
    model: null,
  };
}

export function claudeModelFromTranscript(file: string): string | null {
  try {
    const lines = readTail(file, 64 * 1024).split('\n').reverse();
    for (const line of lines) {
      try {
        const o = JSON.parse(line) as { type?: string; message?: { model?: unknown } };
        if (o.type === 'assistant' && typeof o.message?.model === 'string') return o.message.model;
      } catch {
        // 首行可能被截断
      }
    }
  } catch {
    // 文件不存在
  }
  return null;
}
```

- [ ] **Step 5: 实现 codex.ts**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { codexHome } from '../paths.js';
import { readTail, type HookInput, type ToolClass } from './types.js';

// Codex 的 apply_patch 也按 shell 快照处理，无需解析补丁格式
const SHELL_TOOLS = new Set(['apply_patch', 'exec_command', 'shell', 'shell_command', 'Bash', 'exec', 'multi_tool_use.parallel']);

export function classifyCodexTool(name: string): ToolClass {
  return SHELL_TOOLS.has(name.replace(/^functions\./, '')) ? 'shell' : 'skip';
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function parseCodexHook(raw: unknown): HookInput {
  const data = (raw ?? {}) as Obj;
  return {
    agent: 'codex',
    toolClass: classifyCodexTool(str(data.tool_name) ?? ''),
    sessionId: str(data.session_id) ?? str(data.thread_id) ?? 'unknown',
    toolUseId: str(data.tool_use_id) ?? 'unknown',
    cwd: str(data.cwd) ?? process.cwd(),
    filePath: null,
    fallbackText: null,
    transcriptPath: str(data.transcript_path),
    model: str(data.model),
  };
}

/** 在 sessions/YYYY/MM/DD 下按日期倒序查找 rollout-*-<sessionId>.jsonl */
export function findCodexRollout(sessionId: string): string | null {
  const root = path.join(codexHome(), 'sessions');
  const desc = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  const suffix = `-${sessionId}.jsonl`;
  for (const y of desc(root)) {
    for (const m of desc(path.join(root, y))) {
      for (const d of desc(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        const hit = desc(dir).find((f) => f.endsWith(suffix));
        if (hit) return path.join(dir, hit);
      }
    }
  }
  return null;
}

/** 模型名在 turn_context.payload.model，取日志末尾最近的一条 */
export function codexModelFromRollout(file: string): string | null {
  try {
    const lines = readTail(file, 256 * 1024).split('\n').reverse();
    for (const line of lines) {
      try {
        const o = JSON.parse(line) as { type?: string; payload?: { model?: unknown } };
        if (o.type === 'turn_context' && typeof o.payload?.model === 'string') return o.payload.model;
      } catch {
        // 首行可能被截断
      }
    }
  } catch {
    // 文件不存在
  }
  return null;
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `npx vitest run tests/agents.test.ts`
Expected: PASS

- [ ] **Step 7: 修正 spec 4.6 节**

把 `docs/superpowers/specs/2026-09-24-aicode-stats-design.md` 中这一行：
```
- Codex：优先取钩子输入中的 `model`，没有时读取会话日志首行 `session_meta.payload.model`
```
替换为：
```
- Codex：优先取钩子输入中的 `model`；没有时从会话日志末尾最多 256KB 中，找到最近一条 `turn_context.payload.model`（已在 codex-cli 0.155.1 实测：`session_meta` 中不含模型名，且每轮对话都可能更换模型）
```
如果 Task 1 发现了新的 Codex 工具名，也同步更新 spec 4.1 节的表格。

- [ ] **Step 8: 提交**

```bash
git add src/agents tests/agents.test.ts docs/superpowers/specs/2026-09-24-aicode-stats-design.md
git commit -m "feat: 实现 Claude 与 Codex 钩子输入解析及模型识别

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 钩子编排 runHook

**Files:**
- Create: `src/hook.ts`
- Test: `tests/hook.test.ts`

**Interfaces:**
- Consumes: Task 3–7 的全部导出
- Produces: `HOOK_BUDGET_MS = 2000`、`runHook(phase: Phase, agent: 'claude' | 'codex', raw: unknown): void`（pending key 为 `${agent}_${sessionId}_${toolUseId}`）
- 去重规则（spec 4.4）：`toolUseId` 已知时，pre 在 `hasPending || isDone` 时跳过，post 在 `isDone` 时跳过；`toolUseId` 为 `'unknown'` 时不做去重，以最后一次 pre 为准

- [ ] **Step 1: 编写失败测试**

`tests/hook.test.ts`：
```ts
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fingerprintText } from '../src/fingerprint.js';
import { repoId, repoKey } from '../src/git.js';
import { runHook } from '../src/hook.js';
import { readRecords } from '../src/ledger.js';
import { pendingDir } from '../src/paths.js';
import { commitAll, initRepo, tmpHome } from './helpers.js';

let home: string;
beforeEach(() => {
  home = tmpHome();
});
const records = (repo: string) => readRecords(repoKey(repoId(repo)));

describe('Claude 编辑类工具', () => {
  it('pre/post 对比后只记录新增行，并从 transcript 读取模型', () => {
    const repo = initRepo();
    const file = path.join(repo, 'a.ts');
    fs.writeFileSync(file, 'old line\n');
    commitAll(repo, 'init');
    const transcript = path.join(home, 't.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } }) + '\n');
    const raw = { session_id: 's1', tool_use_id: 't1', cwd: repo, tool_name: 'Edit', tool_input: { file_path: file, new_string: 'ignored' }, transcript_path: transcript };
    runHook('pre', 'claude', raw);
    fs.writeFileSync(file, 'old line\nnew line 1\nnew line 2\n');
    runHook('post', 'claude', raw);
    const recs = records(repo);
    expect(recs.map((r) => r.f)).toEqual(fingerprintText('new line 1\nnew line 2'));
    expect(recs[0]).toMatchObject({ p: 'a.ts', t: 'claude-code', m: 'claude-opus-5-5', s: 's1' });
    expect(fs.readdirSync(pendingDir()).every((n) => n.endsWith('.done'))).toBe(true);
  });

  it('同一次调用触发两遍钩子（全局 + 项目模式）时只记录一次', () => {
    const repo = initRepo();
    const file = path.join(repo, 'd.ts');
    const raw = { session_id: 's', tool_use_id: 'dup', cwd: repo, tool_name: 'Write', tool_input: { file_path: file, content: 'x\ny\n' } };
    runHook('pre', 'claude', raw);
    runHook('pre', 'claude', raw);
    fs.writeFileSync(file, 'x\ny\n');
    runHook('post', 'claude', raw);
    runHook('post', 'claude', raw);
    expect(records(repo).map((r) => r.f)).toEqual(fingerprintText('x\ny'));
  });

  it('没有 pre 基线时退回使用 tool_input 文本', () => {
    const repo = initRepo();
    const file = path.join(repo, 'b.ts');
    fs.writeFileSync(file, 'x\ny\n');
    runHook('post', 'claude', { session_id: 's', tool_use_id: 't', cwd: repo, tool_name: 'Write', tool_input: { file_path: file, content: 'x\ny\n' } });
    expect(records(repo).map((r) => r.f)).toEqual(fingerprintText('x\ny'));
  });

  it('被忽略的文件不记录', () => {
    const repo = initRepo();
    const file = path.join(repo, 'yarn.lock');
    const raw = { session_id: 's', tool_use_id: 't', cwd: repo, tool_name: 'Write', tool_input: { file_path: file, content: 'a' } };
    runHook('pre', 'claude', raw);
    fs.writeFileSync(file, 'a\n');
    runHook('post', 'claude', raw);
    expect(records(repo)).toEqual([]);
  });

  it('跳过 Read 等无关工具，不产生 pending', () => {
    const repo = initRepo();
    runHook('pre', 'claude', { session_id: 's', tool_use_id: 't', cwd: repo, tool_name: 'Read', tool_input: { file_path: path.join(repo, 'a') } });
    expect(fs.existsSync(pendingDir())).toBe(false);
  });
});

describe('shell 类工具', () => {
  it('Claude Bash：排除执行前的人工改动', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.ts'), 'base\n');
    commitAll(repo, 'init');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'base\nhuman\n');
    const raw = { session_id: 's', tool_use_id: 'b1', cwd: repo, tool_name: 'Bash', tool_input: { command: 'x' } };
    runHook('pre', 'claude', raw);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'base\nhuman\nfrom ai\n');
    runHook('post', 'claude', raw);
    expect(records(repo).map((r) => r.f)).toEqual(fingerprintText('from ai'));
  });

  it('Codex exec：使用钩子输入中的 model', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'seed.txt'), 's\n');
    commitAll(repo, 'init');
    const raw = { session_id: 'c1', tool_use_id: 'x1', cwd: repo, tool_name: 'exec', model: 'gpt-5.6-luna' };
    runHook('pre', 'codex', raw);
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'n.ts'), 'codex line\n');
    runHook('post', 'codex', raw);
    expect(records(repo)).toEqual([expect.objectContaining({ p: 'src/n.ts', t: 'codex', m: 'gpt-5.6-luna', s: 'c1' })]);
  });

  it('不在 git 仓库中时不做任何事', () => {
    const raw = { session_id: 's', tool_use_id: 't', cwd: home, tool_name: 'Bash' };
    runHook('pre', 'claude', raw);
    runHook('post', 'claude', raw);
    expect(fs.existsSync(pendingDir())).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/hook.test.ts`
Expected: FAIL，提示无法解析 `../src/hook.js`

- [ ] **Step 3: 实现 hook.ts**

```ts
import { claudeModelFromTranscript, parseClaudeHook } from './agents/claude.js';
import { codexModelFromRollout, findCodexRollout, parseCodexHook } from './agents/codex.js';
import type { HookInput, Phase } from './agents/types.js';
import { loadConfig } from './config.js';
import { fingerprintText } from './fingerprint.js';
import { repoId, repoKey, repoRoot, repoRootForPath, toRepoRelative } from './git.js';
import { buildIgnore, type IgnoreFn } from './ignore.js';
import { appendRecords, type LedgerRecord } from './ledger.js';
import {
  captureEditBaseline, captureShellBaseline, cleanupPending, editChanges, hasPending, isDone, savePending, shellChanges,
  takePending, type Baseline, type Change,
} from './snapshot.js';

export const HOOK_BUDGET_MS = 2000;

export function runHook(phase: Phase, agent: 'claude' | 'codex', raw: unknown): void {
  const input = agent === 'claude' ? parseClaudeHook(raw) : parseCodexHook(raw);
  if (input.toolClass === 'skip') return;
  const deadline = Date.now() + HOOK_BUDGET_MS;
  const key = `${input.agent}_${input.sessionId}_${input.toolUseId}`;
  // 全局与项目模式同时安装时，同一次调用会触发两遍钩子；tool_use_id 未知时无法区分调用，不去重
  const dedupe = input.toolUseId !== 'unknown';

  if (phase === 'pre') {
    cleanupPending();
    if (dedupe && (hasPending(key) || isDone(key))) return;
    const baseline = input.toolClass === 'edit' ? editBaseline(input) : shellBaseline(input, deadline);
    if (baseline) savePending(key, baseline);
    return;
  }

  if (dedupe && isDone(key)) return;
  const baseline = takePending(key);
  const changes = input.toolClass === 'edit' ? editPost(input, baseline) : shellPost(baseline, deadline);
  if (changes.length) record(input, changes);
}

function ignoreFor(root: string): IgnoreFn {
  return buildIgnore(root, loadConfig(root).ignore);
}

function locate(absPath: string): { root: string; rel: string } | null {
  const root = repoRootForPath(absPath);
  if (!root) return null;
  const rel = toRepoRelative(root, absPath);
  if (rel.startsWith('..') || ignoreFor(root)(rel)) return null;
  return { root, rel };
}

function editBaseline(input: HookInput): Baseline | null {
  const loc = input.filePath ? locate(input.filePath) : null;
  return loc ? captureEditBaseline(loc.root, loc.rel) : null;
}

function shellBaseline(input: HookInput, deadline: number): Baseline | null {
  const root = repoRoot(input.cwd);
  return root ? captureShellBaseline(root, ignoreFor(root), deadline) : null;
}

function editPost(input: HookInput, baseline: Baseline | null): Change[] {
  if (baseline?.kind === 'edit') return editChanges(baseline);
  // 基线丢失（pre 失败或未触发）：退回使用工具参数中的新文本
  if (!input.filePath || input.fallbackText === null) return [];
  const loc = locate(input.filePath);
  return loc ? [{ repoRoot: loc.root, rel: loc.rel, fps: fingerprintText(input.fallbackText) }] : [];
}

function shellPost(baseline: Baseline | null, deadline: number): Change[] {
  if (baseline?.kind !== 'shell') return [];
  return shellChanges(baseline, ignoreFor(baseline.repoRoot), deadline);
}

function resolveModel(input: HookInput): string {
  if (input.model) return input.model;
  if (input.agent === 'claude-code') {
    return (input.transcriptPath && claudeModelFromTranscript(input.transcriptPath)) || 'unknown';
  }
  const rollout = input.transcriptPath ?? findCodexRollout(input.sessionId);
  return (rollout && codexModelFromRollout(rollout)) || 'unknown';
}

function record(input: HookInput, changes: Change[]): void {
  const model = resolveModel(input);
  const ts = Math.floor(Date.now() / 1000);
  const byRepo = new Map<string, LedgerRecord[]>();
  for (const c of changes) {
    const list = byRepo.get(c.repoRoot) ?? [];
    for (const f of c.fps) list.push({ p: c.rel, f, t: input.agent, m: model, s: input.sessionId, ts });
    byRepo.set(c.repoRoot, list);
  }
  for (const [root, recs] of byRepo) appendRecords(repoKey(repoId(root)), recs);
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/hook.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/hook.ts tests/hook.test.ts
git commit -m "feat: 实现钩子编排，写入 AI 行指纹

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: commit 统计分析与元数据

**Files:**
- Create: `src/analyzer.ts`, `src/metadata.ts`
- Test: `tests/analyzer.test.ts`, `tests/metadata.test.ts`

**Interfaces:**
- Consumes: `FileDiff`、`LedgerRecord`、`IgnoreFn`、`fingerprintLines`、`globToRegExp`、`ModuleRule`、`AicodeConfig`
- Produces:
  - `analyzer.ts`：`interface FileStat { path: string; module: string; added: number; ai: number }`、`interface ToolStat { ai: number; generated: number }`、`interface CommitStats { added_total: number; added_ai: number; added_human: number; deleted_total: number; ai_ratio: number; ai_generated: number; ai_accept_rate: number; by_tool: Record<string, ToolStat> }`、`interface AnalyzeResult { stats: CommitStats; files: FileStat[]; remaining: LedgerRecord[] }`、`analyzeCommit(diffs: FileDiff[], records: LedgerRecord[], isIgnored: IgnoreFn, moduleOf: (path: string) => string): AnalyzeResult`
  - `metadata.ts`：`moduleFromBranch(branch: string): string`、`createModuleResolver(rules: ModuleRule[], branch: string): (path: string) => string`、`commitModule(files: FileStat[]): string`、`resolveOwner(config: AicodeConfig, author: { name: string; email: string }): { name: string; email: string }`

- [ ] **Step 1: 编写失败测试**

`tests/analyzer.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { analyzeCommit } from '../src/analyzer.js';
import { fingerprint } from '../src/fingerprint.js';
import type { FileDiff } from '../src/git.js';
import { buildIgnore } from '../src/ignore.js';
import type { LedgerRecord } from '../src/ledger.js';

const rec = (p: string, line: string, t = 'claude-code', m = 'opus'): LedgerRecord => ({ p, f: fingerprint(line)!, t, m, s: 's', ts: 1 });
const diff = (path: string, added: string[], extra: Partial<FileDiff> = {}): FileDiff => ({ path, oldPath: null, added, deleted: 0, binary: false, ...extra });
const ignored = buildIgnore(null, []);
const mod = () => 'core';

describe('analyzeCommit', () => {
  it('匹配 AI 行、统计人工行，并按工具/模型拆分', () => {
    const records = [rec('a.ts', 'ai one'), rec('a.ts', 'ai two', 'codex', 'gpt'), rec('other.ts', 'z')];
    const r = analyzeCommit([diff('a.ts', ['ai one', 'ai two', 'human', '', '}'], { deleted: 3 })], records, ignored, mod);
    expect(r.stats).toEqual({
      added_total: 3, added_ai: 2, added_human: 1, deleted_total: 3, ai_ratio: 0.667,
      ai_generated: 2, ai_accept_rate: 1,
      by_tool: { 'claude-code/opus': { ai: 1, generated: 1 }, 'codex/gpt': { ai: 1, generated: 1 } },
    });
    expect(r.files).toEqual([{ path: 'a.ts', module: 'core', added: 3, ai: 2 }]);
    expect(r.remaining).toEqual([records[2]]);
  });

  it('每条指纹只能消费一次', () => {
    const r = analyzeCommit([diff('a.ts', ['dup', 'dup', 'dup'])], [rec('a.ts', 'dup'), rec('a.ts', 'dup')], ignored, mod);
    expect(r.stats.added_ai).toBe(2);
    expect(r.stats.added_human).toBe(1);
  });

  it('重命名的文件也能用旧路径下的指纹匹配', () => {
    const r = analyzeCommit([diff('new.ts', ['x'], { oldPath: 'old.ts' })], [rec('old.ts', 'x')], ignored, mod);
    expect(r.stats.added_ai).toBe(1);
  });

  it('忽略被忽略的文件和二进制文件，未生成 AI 行时比率为 0', () => {
    const r = analyzeCommit(
      [diff('package-lock.json', ['a'], { deleted: 5 }), diff('img.png', [], { binary: true })],
      [rec('package-lock.json', 'a')], ignored, mod,
    );
    expect(r.stats).toMatchObject({ added_total: 0, deleted_total: 0, ai_ratio: 0, ai_generated: 0, ai_accept_rate: 0 });
    expect(r.files).toEqual([]);
  });

  it('生成量包含本次涉及文件中未被提交的 AI 行', () => {
    const r = analyzeCommit([diff('a.ts', ['kept'])], [rec('a.ts', 'kept'), rec('a.ts', 'dropped')], ignored, mod);
    expect(r.stats).toMatchObject({ added_ai: 1, ai_generated: 2, ai_accept_rate: 0.5 });
  });
});
```

`tests/metadata.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { commitModule, createModuleResolver, moduleFromBranch, resolveOwner } from '../src/metadata.js';

describe('metadata', () => {
  it('从分支名提取模块', () => {
    expect(moduleFromBranch('feature/login-v2')).toBe('login-v2');
    expect(moduleFromBranch('hotfix/pay-timeout')).toBe('pay-timeout');
    expect(moduleFromBranch('main')).toBe('unknown');
  });

  it('按规则顺序匹配，未命中时退回分支模块', () => {
    const of = createModuleResolver([{ path: 'src/user/**', name: 'user-center' }, { path: 'src/**', name: 'core' }], 'feature/x');
    expect(of('src/user/a.ts')).toBe('user-center');
    expect(of('src/b.ts')).toBe('core');
    expect(of('docs/a.md')).toBe('x');
  });

  it('commit 级模块取新增行最多的那个', () => {
    expect(commitModule([{ path: 'a', module: 'm1', added: 3, ai: 0 }, { path: 'b', module: 'm2', added: 2, ai: 0 }, { path: 'c', module: 'm2', added: 2, ai: 0 }])).toBe('m2');
    expect(commitModule([])).toBe('unknown');
  });

  it('owner 以配置优先', () => {
    const author = { name: 'git名', email: 'git@x.com' };
    expect(resolveOwner({ modules: [], ignore: [], reporter: { type: 'noop' } }, author)).toEqual(author);
    expect(resolveOwner({ owner: { name: '张三' }, modules: [], ignore: [], reporter: { type: 'noop' } }, author)).toEqual({ name: '张三', email: 'git@x.com' });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/analyzer.test.ts tests/metadata.test.ts`
Expected: FAIL，提示无法解析模块

- [ ] **Step 3: 实现 analyzer.ts**

```ts
import { fingerprintLines } from './fingerprint.js';
import type { FileDiff } from './git.js';
import type { IgnoreFn } from './ignore.js';
import type { LedgerRecord } from './ledger.js';

export interface FileStat { path: string; module: string; added: number; ai: number }
export interface ToolStat { ai: number; generated: number }
export interface CommitStats {
  added_total: number;
  added_ai: number;
  added_human: number;
  deleted_total: number;
  ai_ratio: number;
  ai_generated: number;
  ai_accept_rate: number;
  by_tool: Record<string, ToolStat>;
}
export interface AnalyzeResult { stats: CommitStats; files: FileStat[]; remaining: LedgerRecord[] }

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const toolKey = (r: LedgerRecord): string => `${r.t}/${r.m}`;

export function analyzeCommit(
  diffs: FileDiff[],
  records: LedgerRecord[],
  isIgnored: IgnoreFn,
  moduleOf: (path: string) => string,
): AnalyzeResult {
  const byTool: Record<string, ToolStat> = {};
  const tool = (key: string): ToolStat => (byTool[key] ??= { ai: 0, generated: 0 });
  const counted = diffs.filter((d) => !d.binary && !isIgnored(d.path));

  // 生成量：本次涉及文件（含重命名前路径）在 ledger 中的全部记录
  const touched = new Set(counted.flatMap((d) => (d.oldPath ? [d.path, d.oldPath] : [d.path])));
  let generated = 0;
  for (const r of records) {
    if (touched.has(r.p)) {
      generated++;
      tool(toolKey(r)).generated++;
    }
  }

  // 可消费池：路径+指纹 → 记录下标队列（先写入的先消费）
  const pool = new Map<string, number[]>();
  records.forEach((r, i) => {
    const k = `${r.p}\0${r.f}`;
    const q = pool.get(k);
    if (q) q.push(i);
    else pool.set(k, [i]);
  });
  const take = (p: string, f: string): number | undefined => pool.get(`${p}\0${f}`)?.shift();

  const consumed = new Set<number>();
  const files: FileStat[] = [];
  let addedTotal = 0;
  let addedAi = 0;
  let deletedTotal = 0;
  for (const d of counted) {
    const fps = fingerprintLines(d.added);
    let ai = 0;
    for (const f of fps) {
      const idx = take(d.path, f) ?? (d.oldPath ? take(d.oldPath, f) : undefined);
      if (idx === undefined) continue;
      consumed.add(idx);
      ai++;
      tool(toolKey(records[idx])).ai++;
    }
    files.push({ path: d.path, module: moduleOf(d.path), added: fps.length, ai });
    addedTotal += fps.length;
    addedAi += ai;
    deletedTotal += d.deleted;
  }

  return {
    stats: {
      added_total: addedTotal,
      added_ai: addedAi,
      added_human: addedTotal - addedAi,
      deleted_total: deletedTotal,
      ai_ratio: addedTotal ? round3(addedAi / addedTotal) : 0,
      ai_generated: generated,
      ai_accept_rate: generated ? round3(addedAi / generated) : 0,
      by_tool: byTool,
    },
    files,
    remaining: records.filter((_, i) => !consumed.has(i)),
  };
}
```

- [ ] **Step 4: 实现 metadata.ts**

```ts
import type { FileStat } from './analyzer.js';
import type { AicodeConfig, ModuleRule } from './config.js';
import { globToRegExp } from './ignore.js';

export function moduleFromBranch(branch: string): string {
  const m = /^(?:feature|hotfix)\/(.+)$/.exec(branch);
  return m ? m[1] : 'unknown';
}

export function createModuleResolver(rules: ModuleRule[], branch: string): (path: string) => string {
  const compiled = rules.map((r) => ({ re: globToRegExp(r.path), name: r.name }));
  const fallback = moduleFromBranch(branch);
  return (p) => compiled.find((c) => c.re.test(p))?.name ?? fallback;
}

/** 按模块汇总新增行，取最多的；平局取先出现的 */
export function commitModule(files: FileStat[]): string {
  const totals = new Map<string, number>();
  for (const f of files) totals.set(f.module, (totals.get(f.module) ?? 0) + f.added);
  let best = 'unknown';
  let max = -1;
  for (const [module, n] of totals) {
    if (n > max) {
      best = module;
      max = n;
    }
  }
  return best;
}

export function resolveOwner(config: AicodeConfig, author: { name: string; email: string }): { name: string; email: string } {
  return { name: config.owner?.name ?? author.name, email: config.owner?.email ?? author.email };
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run tests/analyzer.test.ts tests/metadata.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/analyzer.ts src/metadata.ts tests/analyzer.test.ts tests/metadata.test.ts
git commit -m "feat: 实现 commit 统计分析与负责人、模块解析

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 事件存储与 Reporter 扩展接口

**Files:**
- Create: `src/events.ts`, `src/reporter/index.ts`
- Test: `tests/reporter.test.ts`

**Interfaces:**
- Consumes: `eventsPath()`、`reportedPath()`、`CommitStats`、`FileStat`、`ReporterConfig`、`logError`
- Produces:
  - `events.ts`：`interface CommitEvent { event_id: string; repo: string; branch: string; commit_sha: string; parent_sha: string | null; commit_message: string; committed_at: string; amend: boolean; owner: { name: string; email: string }; module: string; stats: CommitStats; files: FileStat[]; client_version: string }`、`appendEvent(e: CommitEvent): void`、`hasEvent(eventId: string): boolean`、`readUnreported(limit: number): CommitEvent[]`、`markReported(eventId: string): void`
  - `reporter/index.ts`：`interface Reporter { name: string; report(event: CommitEvent): Promise<void>; close?(): Promise<void> }`、`noopReporter: Reporter`、`loadReporter(cfg: ReporterConfig): Promise<Reporter>`、`flushEvents(reporter: Reporter, limit?: number): Promise<void>`（结束时无论成败都调用 `close()`）

- [ ] **Step 1: 编写失败测试**

`tests/reporter.test.ts`：
```ts
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, hasEvent, readUnreported, type CommitEvent } from '../src/events.js';
import { flushEvents, loadReporter, noopReporter, type Reporter } from '../src/reporter/index.js';
import { tmpHome } from './helpers.js';

const ev = (id: string): CommitEvent => ({
  event_id: id, repo: 'r', branch: 'main', commit_sha: id, parent_sha: null, commit_message: 'm',
  committed_at: '2026-09-24T10:00:00+08:00', amend: false, owner: { name: 'n', email: 'e' }, module: 'unknown',
  stats: { added_total: 0, added_ai: 0, added_human: 0, deleted_total: 0, ai_ratio: 0, ai_generated: 0, ai_accept_rate: 0, by_tool: {} },
  files: [], client_version: '0.1.0',
});

let home: string;
beforeEach(() => {
  home = tmpHome();
});

describe('events', () => {
  it('追加、判重、读取未上报事件', () => {
    appendEvent(ev('a'));
    appendEvent(ev('b'));
    expect(hasEvent('a')).toBe(true);
    expect(hasEvent('z')).toBe(false);
    expect(readUnreported(1).map((e) => e.event_id)).toEqual(['a']);
  });
});

describe('reporter', () => {
  it('默认使用 noop，flush 后事件被标记为已上报', async () => {
    appendEvent(ev('a'));
    const reporter = await loadReporter({ type: 'noop' });
    expect(reporter).toBe(noopReporter);
    await flushEvents(reporter);
    expect(readUnreported(50)).toEqual([]);
  });

  it('加载自定义模块，并把 options 原样传入', async () => {
    const out = path.join(home, 'out.txt');
    const mod = path.join(home, 'my-reporter.mjs');
    fs.writeFileSync(mod, "import fs from 'node:fs';\nexport default (o) => ({ name: 'file', async report(e) { fs.appendFileSync(o.out, e.event_id + '\\n'); } });\n");
    appendEvent(ev('a'));
    appendEvent(ev('b'));
    await flushEvents(await loadReporter({ type: 'module', module: mod, options: { out } }));
    expect(fs.readFileSync(out, 'utf8')).toBe('a\nb\n');
  });

  it('上报失败时停止，失败的事件保留，下次补发；无论成败都调用 close', async () => {
    appendEvent(ev('a'));
    appendEvent(ev('b'));
    let closed = 0;
    const failing: Reporter = {
      name: 'fail',
      report: async (e) => { if (e.event_id === 'b') throw new Error('网关不可用'); },
      close: async () => { closed++; },
    };
    await flushEvents(failing);
    expect(readUnreported(50).map((e) => e.event_id)).toEqual(['b']);
    expect(closed).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/reporter.test.ts`
Expected: FAIL，提示无法解析模块

- [ ] **Step 3: 实现 events.ts**

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { CommitStats, FileStat } from './analyzer.js';
import { eventsPath, reportedPath } from './paths.js';

export interface CommitEvent {
  event_id: string;
  repo: string;
  branch: string;
  commit_sha: string;
  parent_sha: string | null;
  commit_message: string;
  committed_at: string;
  amend: boolean;
  owner: { name: string; email: string };
  module: string;
  stats: CommitStats;
  files: FileStat[];
  client_version: string;
}

function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // 跳过损坏行
    }
  }
  return out;
}

function appendJsonl(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

export function appendEvent(e: CommitEvent): void {
  appendJsonl(eventsPath(), e);
}

export function hasEvent(eventId: string): boolean {
  return readJsonl<CommitEvent>(eventsPath()).some((e) => e.event_id === eventId);
}

export function readUnreported(limit: number): CommitEvent[] {
  const reported = new Set(readJsonl<{ event_id: string }>(reportedPath()).map((r) => r.event_id));
  return readJsonl<CommitEvent>(eventsPath()).filter((e) => !reported.has(e.event_id)).slice(0, limit);
}

export function markReported(eventId: string): void {
  appendJsonl(reportedPath(), { event_id: eventId });
}
```

- [ ] **Step 4: 实现 reporter/index.ts**

```ts
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

/** type=module 时加载自定义模块，其默认导出为 (options) => Reporter */
export async function loadReporter(cfg: ReporterConfig): Promise<Reporter> {
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
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run tests/reporter.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/events.ts src/reporter tests/reporter.test.ts
git commit -m "feat: 实现事件存储与可扩展的 Reporter 接口

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: commit 编排 runCommit

**Files:**
- Create: `src/commit.ts`
- Test: `tests/commit.test.ts`

**Interfaces:**
- Consumes: git.ts、ledger.ts、analyzer.ts、metadata.ts、events.ts、reporter、config.ts、ignore.ts、`VERSION`
- Produces: `LEDGER_TTL_SECONDS = 604800`、`runCommit(cwd: string): Promise<CommitEvent | null>`（非仓库、merge commit 或已统计过时返回 null）
- 判重、统计、写 ledger、写事件都在同一把 ledger 锁内完成：全局与项目模式各触发一次 `aicode commit` 时，第二个进程会在锁内看到事件已存在并返回 null

- [ ] **Step 1: 编写失败测试**

`tests/commit.test.ts`：
```ts
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCommit } from '../src/commit.js';
import { fingerprintText } from '../src/fingerprint.js';
import { repoId, repoKey } from '../src/git.js';
import { appendRecords, readRecords, type LedgerRecord } from '../src/ledger.js';
import { eventsPath } from '../src/paths.js';
import { commitAll, initRepo, sh, tmpHome } from './helpers.js';

beforeEach(() => tmpHome());
const now = () => Math.floor(Date.now() / 1000);
const aiRecords = (p: string, text: string, ts = now()): LedgerRecord[] =>
  fingerprintText(text).map((f) => ({ p, f, t: 'claude-code', m: 'opus', s: 's1', ts }));

describe('runCommit', () => {
  it('统计 AI 行与人工行，消费 ledger 并写入 events.jsonl', async () => {
    const repo = initRepo();
    sh(repo, ['remote', 'add', 'origin', 'git@gitlab.example.com:group/proj.git']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'init\n');
    commitAll(repo, 'init');
    sh(repo, ['checkout', '-q', '-b', 'feature/login']);
    const key = repoKey(repoId(repo));
    appendRecords(key, [...aiRecords('src/a.ts', 'const a = 1;\nconst b = 2;'), ...aiRecords('src/a.ts', 'stale', now() - 8 * 86400)]);
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const sha = commitAll(repo, 'feat: 登录');

    const event = await runCommit(repo);

    expect(event).toMatchObject({
      event_id: `gitlab.example.com/group/proj:${sha}`,
      repo: 'gitlab.example.com/group/proj',
      branch: 'feature/login',
      commit_sha: sha,
      commit_message: 'feat: 登录',
      amend: false,
      owner: { name: 'Tester', email: 'tester@example.com' },
      module: 'login',
      files: [{ path: 'src/a.ts', module: 'login', added: 3, ai: 2 }],
    });
    expect(event!.stats).toMatchObject({ added_total: 3, added_ai: 2, added_human: 1, ai_generated: 3 });
    expect(readRecords(key)).toEqual([]); // 已消费的被移除，过期的被清理
    expect(fs.readFileSync(eventsPath(), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('同一 commit 不重复统计', async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'init');
    expect(await runCommit(repo)).not.toBeNull();
    expect(await runCommit(repo)).toBeNull();
  });

  it('跳过 merge commit', async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'init');
    sh(repo, ['checkout', '-q', '-b', 'feature/x']);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    commitAll(repo, 'b');
    sh(repo, ['checkout', '-q', 'master']);
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    commitAll(repo, 'c');
    sh(repo, ['merge', '-q', '--no-ff', '-m', 'merge', 'feature/x']);
    expect(await runCommit(repo)).toBeNull();
  });

  it('不在 git 仓库时返回 null', async () => {
    expect(await runCommit(process.env.HOME!)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/commit.test.ts`
Expected: FAIL，提示无法解析 `../src/commit.js`

- [ ] **Step 3: 实现 commit.ts**

```ts
import { analyzeCommit } from './analyzer.js';
import { loadConfig } from './config.js';
import { appendEvent, hasEvent, type CommitEvent } from './events.js';
import { commitDiff, commitInfo, currentBranch, isAmend, repoId, repoKey, repoRoot } from './git.js';
import { buildIgnore } from './ignore.js';
import { readRecords, withLock, writeRecords } from './ledger.js';
import { commitModule, createModuleResolver, resolveOwner } from './metadata.js';
import { flushEvents, loadReporter } from './reporter/index.js';
import { VERSION } from './version.js';

export const LEDGER_TTL_SECONDS = 7 * 86400;

export async function runCommit(cwd: string): Promise<CommitEvent | null> {
  const root = repoRoot(cwd);
  if (!root) return null;
  const info = commitInfo(root, 'HEAD');
  if (info.parents.length > 1) return null; // merge commit 不统计
  const id = repoId(root);
  const eventId = `${id}:${info.sha}`;

  const config = loadConfig(root);
  const branch = currentBranch(root);
  const isIgnored = buildIgnore(root, config.ignore);
  const moduleOf = createModuleResolver(config.modules, branch);
  const diffs = commitDiff(root, info.sha);
  const key = repoKey(id);

  const amend = isAmend(root);
  const owner = resolveOwner(config, { name: info.authorName, email: info.authorEmail });

  const event = withLock(key, (): CommitEvent | null => {
    if (hasEvent(eventId)) return null; // 在锁内判重，避免两个进程同时统计
    const r = analyzeCommit(diffs, readRecords(key), isIgnored, moduleOf);
    const cutoff = Math.floor(Date.now() / 1000) - LEDGER_TTL_SECONDS;
    writeRecords(key, r.remaining.filter((rec) => rec.ts >= cutoff));
    const e: CommitEvent = {
      event_id: eventId,
      repo: id,
      branch,
      commit_sha: info.sha,
      parent_sha: info.parents[0] ?? null,
      commit_message: info.message,
      committed_at: info.committedAt,
      amend,
      owner,
      module: commitModule(r.files),
      stats: r.stats,
      files: r.files,
      client_version: VERSION,
    };
    appendEvent(e);
    return e;
  });
  if (!event) return null;
  await flushEvents(await loadReporter(config.reporter));
  return event;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/commit.test.ts`
Expected: PASS。注意：merge 测试依赖默认分支名 `master`（git 2.15 默认值）。如果执行环境的 git 较新且配置了 `init.defaultBranch`，就在 `initRepo` 之后用 `sh(repo, ['symbolic-ref', 'HEAD', 'refs/heads/master'])` 固定分支名。

- [ ] **Step 5: 提交**

```bash
git add src/commit.ts tests/commit.test.ts
git commit -m "feat: 实现 commit 统计编排与事件生成

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: git hook 安装器（全局与项目）及 exclude 工具

**Files:**
- Modify: `src/git.ts`（新增 `gitCommonDir`、`isTracked`、`localHooksPath`）
- Create: `src/installer/shell.ts`, `src/installer/exclude.ts`, `src/installer/git.ts`
- Test: `tests/installer-git.test.ts`

**Interfaces:**
- Consumes: `gitHooksDir()`、`installStatePath()`、`git`、`tryGit`
- Produces:
  - `git.ts` 新增：`gitCommonDir(repo: string): string`（绝对路径）、`isTracked(repo: string, rel: string): boolean`、`localHooksPath(repo: string): string | null`
  - `shell.ts`：`shq(s: string): string`、`cliPath(): string`、`aicodeCommand(args: string): string`（形如 `'<node>' '<cli>' <args>`）
  - `exclude.ts`：`addExclude(repo: string, patterns: string[]): void`、`removeExclude(repo: string): void`
  - `installer/git.ts`：`HOOK_NAMES: string[]`、`renderForwarder(name: string, prevHooksPath: string | null, commitCommand: string): string`、`installGitHooks(): void`、`uninstallGitHooks(): void`、`projectHookPath(repo: string): string`、`renderProjectPostCommit(origPath: string, commitCommand: string): string`、`installProjectGitHook(repo: string): void`、`uninstallProjectGitHook(repo: string): void`

- [ ] **Step 1: 编写失败测试**

`tests/installer-git.test.ts`：
```ts
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { gitCommonDir, isTracked, localHooksPath } from '../src/git.js';
import { addExclude, removeExclude } from '../src/installer/exclude.js';
import {
  installGitHooks, installProjectGitHook, projectHookPath, renderForwarder, uninstallGitHooks, uninstallProjectGitHook,
} from '../src/installer/git.js';
import { gitHooksDir } from '../src/paths.js';
import { commitAll, initRepo, sh, tmpHome } from './helpers.js';

let home: string;
beforeEach(() => {
  home = tmpHome();
});
const globalHooksPath = () => {
  try {
    return execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], { cwd: home, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

describe('git 辅助函数', () => {
  it('gitCommonDir / isTracked / localHooksPath', () => {
    const repo = initRepo();
    expect(gitCommonDir(repo)).toBe(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'init');
    expect(isTracked(repo, 'a.txt')).toBe(true);
    expect(isTracked(repo, 'b.txt')).toBe(false);
    expect(localHooksPath(repo)).toBeNull();
    sh(repo, ['config', 'core.hooksPath', '.husky/_']);
    expect(localHooksPath(repo)).toBe('.husky/_');
  });
});

describe('exclude', () => {
  it('写入标记区块，重复写入幂等，移除后还原', () => {
    const repo = initRepo();
    const file = path.join(repo, '.git', 'info', 'exclude');
    const original = fs.readFileSync(file, 'utf8');
    addExclude(repo, ['/.claude/settings.local.json']);
    addExclude(repo, ['/.claude/settings.local.json', '/.codex/config.toml']);
    const text = fs.readFileSync(file, 'utf8');
    expect(text.match(/# >>> aicode >>>/g)).toHaveLength(1);
    expect(text).toContain('/.codex/config.toml');
    fs.mkdirSync(path.join(repo, '.codex'));
    fs.writeFileSync(path.join(repo, '.codex', 'config.toml'), 'x\n');
    expect(sh(repo, ['status', '--porcelain'])).toBe('');
    removeExclude(repo);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});

describe('全局模式', () => {
  it('只有 post-commit 会额外在后台启动统计', () => {
    expect(renderForwarder('post-commit', null, "'node' 'cli' commit")).toContain("( 'node' 'cli' commit </dev/null >/dev/null 2>&1 & )");
    expect(renderForwarder('pre-commit', null, "'node' 'cli' commit")).not.toContain('commit </dev/null');
  });

  it('设置全局 hooksPath，转发到仓库自有 hook 并保留其退出码', () => {
    installGitHooks();
    expect(globalHooksPath()).toBe(gitHooksDir());
    const repo = initRepo();
    const local = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(local, '#!/bin/sh\necho blocked >&2\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    sh(repo, ['add', '-A']);
    expect(() => sh(repo, ['commit', '-q', '-m', 'x'])).toThrow();
    fs.unlinkSync(local);
    expect(() => sh(repo, ['commit', '-q', '-m', 'x'])).not.toThrow();
  });

  it('原来已有全局 hooksPath 时，转发到原路径；卸载后恢复原值', () => {
    const prev = path.join(home, 'my-hooks');
    fs.mkdirSync(prev);
    execFileSync('git', ['config', '--global', 'core.hooksPath', prev], { cwd: home });
    installGitHooks();
    installGitHooks(); // 重复安装时不会把自身记为原路径
    expect(fs.readFileSync(path.join(gitHooksDir(), 'pre-commit'), 'utf8')).toContain(prev);
    uninstallGitHooks();
    expect(globalHooksPath()).toBe(prev);
  });

  it('原来没有全局 hooksPath 时，卸载后删除该配置', () => {
    installGitHooks();
    uninstallGitHooks();
    expect(globalHooksPath()).toBeNull();
    expect(fs.existsSync(gitHooksDir())).toBe(false);
  });
});

describe('项目模式', () => {
  it('保留并调用原有 post-commit，可重复安装，卸载后还原', () => {
    const repo = initRepo();
    const hook = projectHookPath(repo);
    const marker = path.join(repo, '..', `marker-${path.basename(repo)}`);
    const original = `#!/bin/sh\necho ran > '${marker}'\n`;
    fs.writeFileSync(hook, original, { mode: 0o755 });
    installProjectGitHook(repo);
    installProjectGitHook(repo);
    expect(fs.readFileSync(hook + '.aicode-orig', 'utf8')).toBe(original);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'init');
    expect(fs.existsSync(marker)).toBe(true);
    uninstallProjectGitHook(repo);
    expect(fs.readFileSync(hook, 'utf8')).toBe(original);
    expect(fs.existsSync(hook + '.aicode-orig')).toBe(false);
  });

  it('原来没有 post-commit 时，卸载后删除', () => {
    const repo = initRepo();
    installProjectGitHook(repo);
    expect(fs.readFileSync(projectHookPath(repo), 'utf8')).toContain('# aicode project post-commit');
    uninstallProjectGitHook(repo);
    expect(fs.existsSync(projectHookPath(repo))).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/installer-git.test.ts`
Expected: FAIL，提示无法解析模块或导出不存在

- [ ] **Step 3: 在 src/git.ts 末尾追加辅助函数**

```ts
export function gitCommonDir(repo: string): string {
  return path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']).trim());
}

export function isTracked(repo: string, rel: string): boolean {
  return tryGit(repo, ['ls-files', '--error-unmatch', rel]) !== null;
}

/** 仓库级 core.hooksPath（如 husky），存在时全局与项目模式的 hook 都不会被 git 调用 */
export function localHooksPath(repo: string): string | null {
  return tryGit(repo, ['config', '--local', '--get', 'core.hooksPath'])?.trim() || null;
}
```

- [ ] **Step 4: 实现 installer/shell.ts**

```ts
import { fileURLToPath } from 'node:url';

/** POSIX shell 单引号转义 */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 编译后位于 dist/installer/shell.js，CLI 入口为 dist/cli.js */
export function cliPath(): string {
  return fileURLToPath(new URL('../cli.js', import.meta.url));
}

/** 使用 node 与 CLI 的绝对路径，避免钩子运行时 PATH 中找不到 node（如 nvm） */
export function aicodeCommand(args: string): string {
  return `${shq(process.execPath)} ${shq(cliPath())} ${args}`;
}
```

- [ ] **Step 5: 实现 installer/exclude.ts**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { gitCommonDir } from '../git.js';

// .gitignore 语法不支持行尾注释，所以用首尾标记行包住 aicode 写入的条目
const BEGIN = '# >>> aicode >>>';
const END = '# <<< aicode <<<';

function excludeFile(repo: string): string {
  return path.join(gitCommonDir(repo), 'info', 'exclude');
}

function strip(text: string): string {
  return text.replace(new RegExp(`${BEGIN}\\n[\\s\\S]*?${END}\\n`, 'g'), '');
}

export function addExclude(repo: string, patterns: string[]): void {
  const file = excludeFile(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = fs.existsSync(file) ? strip(fs.readFileSync(file, 'utf8')) : '';
  if (text.length && !text.endsWith('\n')) text += '\n';
  fs.writeFileSync(file, `${text}${BEGIN}\n${patterns.join('\n')}\n${END}\n`);
}

export function removeExclude(repo: string): void {
  const file = excludeFile(repo);
  if (fs.existsSync(file)) fs.writeFileSync(file, strip(fs.readFileSync(file, 'utf8')));
}
```

- [ ] **Step 6: 实现 installer/git.ts**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitCommonDir, tryGit } from '../git.js';
import { gitHooksDir, installStatePath } from '../paths.js';
import { aicodeCommand, shq } from './shell.js';

export const HOOK_NAMES = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'post-rewrite',
  'pre-auto-gc', 'push-to-checkout', 'sendemail-validate', 'reference-transaction',
];
const PROJECT_MARK = '# aicode project post-commit';
const backgroundCommit = (commitCommand: string): string => `( ${commitCommand} </dev/null >/dev/null 2>&1 & )`;

// ---------- 全局模式 ----------

interface InstallState { prevHooksPath: string | null }

function readState(): InstallState {
  try {
    return JSON.parse(fs.readFileSync(installStatePath(), 'utf8')) as InstallState;
  } catch {
    return { prevHooksPath: null };
  }
}

function writeState(state: InstallState): void {
  fs.mkdirSync(path.dirname(installStatePath()), { recursive: true });
  fs.writeFileSync(installStatePath(), JSON.stringify(state, null, 2) + '\n');
}

function globalGit(args: string[]): void {
  execFileSync('git', ['config', '--global', ...args], { cwd: os.homedir(), stdio: 'ignore' });
}

function currentGlobalHooksPath(): string | null {
  const v = tryGit(os.homedir(), ['config', '--global', '--get', 'core.hooksPath'])?.trim();
  return v ? v.replace(/^~(?=\/)/, os.homedir()) : null;
}

/**
 * 模拟 git 原有行为：原来设置了全局 hooksPath 就只调用它，否则调用仓库自己的 .git/hooks。
 * 透传原 hook 的退出码；post-commit 额外在后台启动统计，不阻塞 commit。
 */
export function renderForwarder(name: string, prevHooksPath: string | null, commitCommand: string): string {
  const lines = [
    '#!/bin/sh',
    '# 由 aicode 生成：转发到原有 hook',
    `HOOK_NAME=${shq(name)}`,
    `PREV_HOOKS=${shq(prevHooksPath ?? '')}`,
    'if [ -n "$PREV_HOOKS" ]; then TARGET="$PREV_HOOKS/$HOOK_NAME"; else TARGET="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/$HOOK_NAME"; fi',
    'status=0',
    'if [ -x "$TARGET" ]; then "$TARGET" "$@"; status=$?; fi',
  ];
  if (name === 'post-commit') lines.push(backgroundCommit(commitCommand));
  lines.push('exit $status');
  return lines.join('\n') + '\n';
}

export function installGitHooks(): void {
  const dir = gitHooksDir();
  fs.mkdirSync(dir, { recursive: true });
  const current = currentGlobalHooksPath();
  const prev = current && path.resolve(current) !== dir ? current : readState().prevHooksPath;
  writeState({ prevHooksPath: prev });
  const commitCommand = aicodeCommand('commit');
  for (const name of HOOK_NAMES) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, renderForwarder(name, prev, commitCommand));
    fs.chmodSync(file, 0o755);
  }
  globalGit(['core.hooksPath', dir]);
}

export function uninstallGitHooks(): void {
  const current = currentGlobalHooksPath();
  if (current && path.resolve(current) === gitHooksDir()) {
    const { prevHooksPath } = readState();
    if (prevHooksPath) globalGit(['core.hooksPath', prevHooksPath]);
    else globalGit(['--unset', 'core.hooksPath']);
  }
  fs.rmSync(gitHooksDir(), { recursive: true, force: true });
  fs.rmSync(installStatePath(), { force: true });
}

// ---------- 项目模式 ----------

export function projectHookPath(repo: string): string {
  return path.join(gitCommonDir(repo), 'hooks', 'post-commit');
}

export function renderProjectPostCommit(origPath: string, commitCommand: string): string {
  return [
    '#!/bin/sh',
    PROJECT_MARK,
    `ORIG=${shq(origPath)}`,
    'status=0',
    'if [ -x "$ORIG" ]; then "$ORIG" "$@"; status=$?; fi',
    backgroundCommit(commitCommand),
    'exit $status',
  ].join('\n') + '\n';
}

function isAicodeHook(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes(PROJECT_MARK);
  } catch {
    return false;
  }
}

export function installProjectGitHook(repo: string): void {
  const hook = projectHookPath(repo);
  const orig = hook + '.aicode-orig';
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  if (fs.existsSync(hook) && !isAicodeHook(hook) && !fs.existsSync(orig)) fs.renameSync(hook, orig);
  fs.writeFileSync(hook, renderProjectPostCommit(orig, aicodeCommand('commit')));
  fs.chmodSync(hook, 0o755);
}

export function uninstallProjectGitHook(repo: string): void {
  const hook = projectHookPath(repo);
  const orig = hook + '.aicode-orig';
  if (isAicodeHook(hook)) fs.unlinkSync(hook);
  if (fs.existsSync(orig)) fs.renameSync(orig, hook);
}
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `npx vitest run tests/installer-git.test.ts tests/git.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/git.ts src/installer tests/installer-git.test.ts
git commit -m "feat: 实现全局与项目模式的 git hook 安装及 exclude 工具

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Claude Code 与 Codex 钩子安装器

两个安装器都以**目标文件路径**作为参数，全局模式和项目模式共用同一套实现。

Task 1 的真机结论（见 `docs/superpowers/notes/2026-09-24-codex-hooks-probe.md`）：
- 全局模式：钩子与信任记录都写在 `~/.codex/config.toml`，Codex 可以识别
- 项目模式：Codex **不接受**写在仓库 `.codex/config.toml` 里的信任记录，钩子会被静默跳过。钩子定义写在项目文件中（不含 `hooks.state`），信任记录写在全局 `~/.codex/config.toml` 中，key 仍用项目配置文件的绝对路径。每个项目的信任记录用 `# >>> aicode trust <项目配置路径> >>>` / `# <<< aicode trust <项目配置路径> <<<` 包住

**Files:**
- Create: `src/installer/claude.ts`, `src/installer/codex.ts`
- Test: `tests/installer-agents.test.ts`

**Interfaces:**
- Consumes: `codexHome()`、`aicodeCommand`
- Produces:
  - `claude.ts`：`CLAUDE_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash'`、`isAicodeClaudeCommand(cmd: string): boolean`、`installClaude(settingsFile: string): void`、`uninstallClaude(settingsFile: string): void`
  - `codex.ts`：`codexTrustHash(eventSnake: string, command: string): string`、`applyCodexInstall(text: string, configPath: string, preCmd: string, postCmd: string, withTrust?: boolean): string`（`withTrust` 默认 true；为 false 时不写 `hooks.state`）、`removeCodexInstall(text: string): string`、`codexGroupIndexes(text: string): [number, number]`、`applyCodexTrust(text: string, projectConfigPath: string, preCmd: string, postCmd: string, indexes: [number, number]): string`、`removeCodexTrust(text: string, projectConfigPath: string): string`、`installCodex(configFile: string): void`、`uninstallCodex(configFile: string): void`、`installProjectCodex(projectConfigFile: string): void`、`uninstallProjectCodex(projectConfigFile: string): void`、`isCodexTrusted(repoRoot: string): boolean`
- 卸载约定：卸载后文件内容为空（Claude 为 `{}`，Codex 为空白），**且没有 `.aicode.bak` 备份**（说明文件是 aicode 创建的），就删除该文件

- [ ] **Step 1: 编写失败测试**

`tests/installer-agents.test.ts`：
```ts
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
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/installer-agents.test.ts`
Expected: FAIL，提示无法解析模块

- [ ] **Step 3: 实现 installer/claude.ts**

```ts
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
  if (fs.existsSync(file) && !fs.existsSync(file + '.aicode.bak')) fs.copyFileSync(file, file + '.aicode.bak');
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
  // 文件由 aicode 创建（无备份）且已清空时直接删除
  if (Object.keys(s).length === 0 && !fs.existsSync(settingsFile + '.aicode.bak')) fs.unlinkSync(settingsFile);
  else writeSettings(settingsFile, s);
}
```

- [ ] **Step 4: 实现 installer/codex.ts**

```ts
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
  if (fs.existsSync(file) && !fs.existsSync(file + '.aicode.bak')) fs.copyFileSync(file, file + '.aicode.bak');
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
  if (fs.existsSync(globalFile)) fs.writeFileSync(globalFile, removeCodexTrust(fs.readFileSync(globalFile, 'utf8'), projectConfigFile));
}

export function uninstallCodex(configFile: string): void {
  if (!fs.existsSync(configFile)) return;
  const text = removeCodexInstall(fs.readFileSync(configFile, 'utf8'));
  // 文件由 aicode 创建（无备份）且已清空时直接删除
  if (text.trim() === '' && !fs.existsSync(configFile + '.aicode.bak')) fs.unlinkSync(configFile);
  else fs.writeFileSync(configFile, text);
}

/** Codex 只为已信任的项目加载项目级 .codex/config.toml */
export function isCodexTrusted(repoRoot: string): boolean {
  const file = path.join(codexHome(), 'config.toml');
  if (!fs.existsSync(file)) return false;
  const header = `^\\[projects\\.${escapeRe(JSON.stringify(repoRoot))}\\][ \\t]*\\n(?:[^\\[\\n].*\\n|\\n)*?trust_level\\s*=\\s*"trusted"`;
  return new RegExp(header, 'm').test(fs.readFileSync(file, 'utf8'));
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run tests/installer-agents.test.ts`
Expected: PASS。如果"卸载后与原文一致"失败，检查 feature 行的换行：插入的是紧跟在 `[features]` 之后的 `\n` + FEATURE_LINE，移除时删掉 `FEATURE_LINE\n`，两者必须对称。

- [ ] **Step 6: 提交**

```bash
git add src/installer/claude.ts src/installer/codex.ts tests/installer-agents.test.ts
git commit -m "feat: 实现 Claude Code 与 Codex 钩子安装器

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: init（全局 / 项目模式、确认）、CLI 入口与端到端测试

**Files:**
- Create: `src/init.ts`, `src/cli.ts`
- Test: `tests/init.test.ts`, `tests/e2e.test.ts`

**Interfaces:**
- Consumes: 全部安装器、`runHook`、`runCommit`、`writeDefaultConfig`、`logError`、`repoRoot`、`isTracked`、`localHooksPath`、paths
- Produces:
  - `init.ts`：`interface Step { file: string; summary: string; apply: () => void }`、`interface Plan { steps: Step[]; notes: string[] }`、`planGlobal(uninstall: boolean): Plan`、`planProject(cwd: string, uninstall: boolean): Plan`（cwd 不在 git 仓库中时抛出 Error）
  - 可执行文件 `dist/cli.js`：`init [--project] [--uninstall] [--yes]`、`hook <pre|post> --tool <claude|codex>`、`commit`

- [ ] **Step 1: 编写 init 的失败测试**

`tests/init.test.ts`：
```ts
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { planGlobal, planProject } from '../src/init.js';
import { commitAll, initRepo, sh, tmpHome } from './helpers.js';

let home: string;
beforeEach(() => {
  home = tmpHome();
});
const applyAll = (plan: { steps: { apply: () => void }[] }) => plan.steps.forEach((s) => s.apply());

describe('planGlobal', () => {
  it('未安装 Codex 时不包含 Codex 步骤，并给出提示', () => {
    const plan = planGlobal(false);
    expect(plan.steps.map((s) => s.file)).toEqual([
      path.join(home, '.aicode', 'config.json'),
      path.join(home, '.claude', 'settings.json'),
      '~/.gitconfig（core.hooksPath）',
    ]);
    expect(plan.notes.join('\n')).toContain('未检测到 Codex');
  });
});

describe('planProject', () => {
  it('不在 git 仓库中时报错', () => {
    expect(() => planProject(home, false)).toThrow('当前目录不在 git 仓库中');
  });

  it('安装 Claude、已信任项目的 Codex、exclude 和 post-commit；卸载后全部还原', () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(home, '.codex'));
    const globalCodex = `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`;
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), globalCodex);
    const excludeBefore = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');

    const plan = planProject(repo, false);
    expect(plan.steps.map((s) => path.relative(repo, s.file))).toEqual(
      expect.arrayContaining(['.claude/settings.local.json', '.codex/config.toml', '.git/info/exclude', '.git/hooks/post-commit']),
    );
    applyAll(plan);
    expect(fs.existsSync(path.join(repo, '.claude', 'settings.local.json'))).toBe(true);
    expect(fs.readFileSync(path.join(repo, '.codex', 'config.toml'), 'utf8')).toContain('# >>> aicode hooks >>>');
    expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toContain('# >>> aicode trust ');
    expect(sh(repo, ['status', '--porcelain'])).toBe('');

    applyAll(planProject(repo, true));
    expect(fs.existsSync(path.join(repo, '.claude', 'settings.local.json'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.codex', 'config.toml'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe(excludeBefore);
    expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toBe(globalCodex);
  });

  it('跳过已被 git 跟踪的配置文件和未信任的 Codex 项目，并提示仓库级 hooksPath', () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{}\n');
    commitAll(repo, 'track settings');
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n');
    sh(repo, ['config', 'core.hooksPath', '.husky/_']);

    const plan = planProject(repo, false);
    const files = plan.steps.map((s) => path.relative(repo, s.file));
    expect(files).not.toContain('.claude/settings.local.json');
    expect(files).not.toContain('.codex/config.toml');
    const notes = plan.notes.join('\n');
    expect(notes).toContain('已被 git 跟踪');
    expect(notes).toContain('未被 Codex 信任');
    expect(notes).toContain('core.hooksPath');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/init.test.ts`
Expected: FAIL，提示无法解析 `../src/init.js`

- [ ] **Step 3: 实现 init.ts**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { writeDefaultConfig } from './config.js';
import { isTracked, localHooksPath, repoRoot } from './git.js';
import { installClaude, uninstallClaude } from './installer/claude.js';
import { installCodex, installProjectCodex, isCodexTrusted, uninstallCodex, uninstallProjectCodex } from './installer/codex.js';
import { addExclude, removeExclude } from './installer/exclude.js';
import {
  installGitHooks, installProjectGitHook, projectHookPath, uninstallGitHooks, uninstallProjectGitHook,
} from './installer/git.js';
import { aicodeHome, claudeSettingsPath, codexHome, configPath, ledgerDir, logPath, pendingDir } from './paths.js';

export interface Step { file: string; summary: string; apply: () => void }
export interface Plan { steps: Step[]; notes: string[] }

const PROJECT_CLAUDE = '.claude/settings.local.json';
const PROJECT_CODEX = '.codex/config.toml';
const HUSKY_NOTE = (p: string) => `该仓库设置了仓库级 core.hooksPath=${p}（如 husky），git 不会调用 aicode 的 post-commit，commit 统计不会触发`;

function homeStep(): Step {
  return {
    file: configPath(),
    summary: '创建 ~/.aicode 目录结构；配置文件不存在时写入默认配置；把配置文件权限设为 600',
    apply: () => {
      for (const dir of [aicodeHome(), ledgerDir(), pendingDir(), path.dirname(logPath())]) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(configPath())) writeDefaultConfig();
      fs.chmodSync(configPath(), 0o600); // 可能包含数据库密码，仅本人可读写
    },
  };
}

export function planGlobal(uninstall: boolean): Plan {
  const steps: Step[] = [];
  const notes: string[] = [];
  const codexConfig = path.join(codexHome(), 'config.toml');
  const hasCodex = fs.existsSync(codexHome());
  if (!uninstall) steps.push(homeStep());
  steps.push({
    file: claudeSettingsPath(),
    summary: uninstall ? '移除 aicode 的 PreToolUse/PostToolUse 钩子' : '合并 PreToolUse/PostToolUse 钩子（已存在的文件先备份为 .aicode.bak）',
    apply: () => (uninstall ? uninstallClaude(claudeSettingsPath()) : installClaude(claudeSettingsPath())),
  });
  if (hasCodex) {
    steps.push({
      file: codexConfig,
      summary: uninstall ? '移除 aicode 钩子区块与 features 标记行' : '开启 [features].hooks，追加钩子与信任记录（先备份为 .aicode.bak）',
      apply: () => (uninstall ? uninstallCodex(codexConfig) : installCodex(codexConfig)),
    });
  } else {
    notes.push('未检测到 Codex（~/.codex 不存在），已跳过');
  }
  steps.push({
    file: '~/.gitconfig（core.hooksPath）',
    summary: uninstall ? '恢复原来的全局 core.hooksPath，删除转发脚本' : '设置全局 core.hooksPath=~/.aicode/git-hooks，并生成转发到原有 hook 的脚本',
    apply: () => (uninstall ? uninstallGitHooks() : installGitHooks()),
  });
  if (!uninstall) notes.push('仓库级设置了 core.hooksPath 的仓库（如 husky）不会触发 commit 统计');
  return { steps, notes };
}

export function planProject(cwd: string, uninstall: boolean): Plan {
  const root = repoRoot(cwd);
  if (!root) throw new Error('当前目录不在 git 仓库中');
  const steps: Step[] = [];
  const notes: string[] = [];
  const claudeFile = path.join(root, PROJECT_CLAUDE);
  const codexFile = path.join(root, PROJECT_CODEX);
  const excludeFile = path.join(root, '.git', 'info', 'exclude');
  const hookFile = projectHookPath(root);

  if (uninstall) {
    steps.push({ file: claudeFile, summary: '移除 aicode 钩子', apply: () => uninstallClaude(claudeFile) });
    steps.push({ file: codexFile, summary: '移除 aicode 钩子区块，并删除 ~/.codex/config.toml 中该项目的信任区块', apply: () => uninstallProjectCodex(codexFile) });
    steps.push({ file: excludeFile, summary: '移除 aicode 写入的忽略条目', apply: () => removeExclude(root) });
    steps.push({ file: hookFile, summary: '删除 aicode 的 post-commit，恢复原有 hook', apply: () => uninstallProjectGitHook(root) });
    return { steps, notes };
  }

  steps.push(homeStep());
  const excludes: string[] = [];
  if (isTracked(root, PROJECT_CLAUDE)) {
    notes.push(`${PROJECT_CLAUDE} 已被 git 跟踪，为避免改动团队共享配置已跳过 Claude Code；可改用全局模式`);
  } else {
    steps.push({ file: claudeFile, summary: '合并 PreToolUse/PostToolUse 钩子', apply: () => installClaude(claudeFile) });
    excludes.push(`/${PROJECT_CLAUDE}`);
  }
  if (isTracked(root, PROJECT_CODEX)) {
    notes.push(`${PROJECT_CODEX} 已被 git 跟踪，已跳过 Codex；可改用全局模式`);
  } else if (!isCodexTrusted(root)) {
    notes.push('该项目未被 Codex 信任（~/.codex/config.toml 中没有 trust_level = "trusted"），Codex 不会加载项目级配置，已跳过 Codex');
  } else {
    steps.push({
      file: codexFile,
      summary: '写入项目钩子；并在全局 ~/.codex/config.toml 追加该项目的信任区块（Codex 只认全局文件中的信任记录；先备份为 .aicode.bak，卸载时删除该区块）',
      apply: () => installProjectCodex(codexFile),
    });
    excludes.push(`/${PROJECT_CODEX}`);
  }
  if (excludes.length) {
    steps.push({ file: excludeFile, summary: `追加忽略条目 ${excludes.join(' ')}，避免出现在 git status 中`, apply: () => addExclude(root, excludes) });
  }
  steps.push({ file: hookFile, summary: '写入 post-commit；已有的 hook 改名为 post-commit.aicode-orig 并在其中被调用', apply: () => installProjectGitHook(root) });
  const local = localHooksPath(root);
  if (local) notes.push(HUSKY_NOTE(local));
  return { steps, notes };
}
```

- [ ] **Step 4: 运行 init 测试，确认通过**

Run: `npx vitest run tests/init.test.ts`
Expected: PASS

- [ ] **Step 5: 编写端到端失败测试**

`tests/e2e.test.ts`（运行编译产物 `dist/cli.js`，`npm test` 会先执行 tsc）：
```ts
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { commitAll, initRepo, tmpHome } from './helpers.js';

const CLI = path.resolve('dist/cli.js');
let home: string;
beforeEach(() => {
  home = tmpHome();
});

const run = (args: string[], input?: unknown, cwd?: string) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    input: input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });

const readEvents = () => {
  const p = path.join(home, '.aicode', 'events.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

async function waitForEvent(sha: string, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const e = readEvents().find((x) => x.commit_sha === sha);
    if (e) return e;
    if (Date.now() > end) throw new Error('等待统计事件超时');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 模拟 AI：Claude 用 Write 新建 3 行；Codex 用 exec 新建 1 行；人工改 1 行、加 1 行 */
function simulateAiAndHuman(repo: string) {
  const file = path.join(repo, 'src', 'a.ts');
  const edit = { session_id: 's1', tool_use_id: 'e1', cwd: repo, tool_name: 'Write', tool_input: { file_path: file, content: '' } };
  run(['hook', 'pre', '--tool', 'claude'], edit);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  run(['hook', 'post', '--tool', 'claude'], edit);
  const exec = { session_id: 'c1', tool_use_id: 'b1', cwd: repo, tool_name: 'exec', model: 'gpt-x' };
  run(['hook', 'pre', '--tool', 'codex'], exec);
  fs.writeFileSync(path.join(repo, 'b.ts'), 'shell line\n');
  run(['hook', 'post', '--tool', 'codex'], exec);
  fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\nconst c = 30;\nconst human = true;\n');
}

describe('端到端', () => {
  it('全局模式：init --yes → 钩子采集 → 人工修改 → git commit → 生成事件', async () => {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n');
    expect(run(['init', '--yes']).status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toContain('# >>> aicode hooks >>>');
    expect(fs.statSync(path.join(home, '.aicode', 'config.json')).mode & 0o777).toBe(0o600);

    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'README.md'), 'init\n');
    commitAll(repo, 'init');
    simulateAiAndHuman(repo);
    const sha = commitAll(repo, 'feat: e2e');

    const event = await waitForEvent(sha);
    expect(event.stats).toMatchObject({ added_total: 5, added_ai: 3, added_human: 2, ai_generated: 4 });
    expect(Object.keys(event.stats.by_tool).sort()).toEqual(['claude-code/unknown', 'codex/gpt-x']);
  });

  it('全局 + 项目模式同时安装时，AI 行和事件都不重复', async () => {
    run(['init', '--yes']);
    const repo = initRepo();
    expect(run(['init', '--project', '--yes'], undefined, repo).status).toBe(0);
    fs.writeFileSync(path.join(repo, 'README.md'), 'init\n');
    commitAll(repo, 'init');
    // 两套钩子各触发一次：pre、pre、post、post
    const file = path.join(repo, 'x.ts');
    const edit = { session_id: 's', tool_use_id: 'd1', cwd: repo, tool_name: 'Write', tool_input: { file_path: file, content: 'ai\n' } };
    run(['hook', 'pre', '--tool', 'claude'], edit);
    run(['hook', 'pre', '--tool', 'claude'], edit);
    fs.writeFileSync(file, 'ai\n');
    run(['hook', 'post', '--tool', 'claude'], edit);
    run(['hook', 'post', '--tool', 'claude'], edit);
    const sha = commitAll(repo, 'feat: dup');
    const event = await waitForEvent(sha);
    await new Promise((r) => setTimeout(r, 1000)); // 等第二个后台统计进程结束
    expect(readEvents().filter((e) => e.commit_sha === sha)).toHaveLength(1);
    expect(event.stats).toMatchObject({ added_ai: 1, ai_generated: 1 });
  });

  it('非交互环境下没有 --yes 时中止，且不写入任何文件', () => {
    const r = run(['init']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--yes');
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('hook 输入损坏时退出码仍为 0，并写入日志', () => {
    expect(run(['hook', 'pre', '--tool', 'claude'], '{bad').status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.aicode', 'logs', 'aicode.log'), 'utf8')).toContain('[hook]');
  });

  it('init --uninstall --yes 移除全部钩子', () => {
    run(['init', '--yes']);
    expect(run(['init', '--uninstall', '--yes']).status).toBe(0);
    expect(() => execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], { cwd: home, env: { ...process.env, HOME: home } })).toThrow();
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false); // 由 aicode 创建，卸载时删除
  });
});
```

- [ ] **Step 6: 实现 cli.ts**

```ts
#!/usr/bin/env node
import readline from 'node:readline';
import { runCommit } from './commit.js';
import { runHook } from './hook.js';
import { planGlobal, planProject } from './init.js';
import { logError } from './log.js';

const USAGE = [
  '用法:',
  '  aicode init [--project] [--uninstall] [--yes]   安装 / 卸载钩子（--project 仅作用于当前仓库）',
  '  aicode hook <pre|post> --tool <claude|codex>    由 AI 工具钩子调用',
  '  aicode commit                                   由 post-commit 调用',
].join('\n');

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function init(flags: string[]): Promise<number> {
  const uninstall = flags.includes('--uninstall');
  const plan = flags.includes('--project') ? planProject(process.cwd(), uninstall) : planGlobal(uninstall);
  console.log(uninstall ? '将执行以下卸载操作：' : '将执行以下改动：');
  for (const s of plan.steps) console.log(`  - ${s.file}\n      ${s.summary}`);
  for (const n of plan.notes) console.log(`  ! ${n}`);
  if (!flags.includes('--yes')) {
    if (!process.stdin.isTTY) {
      console.error('非交互环境下请加 --yes 确认执行');
      return 1;
    }
    if (!(await confirm('确认执行？[y/N] '))) {
      console.log('已取消，未做任何改动');
      return 0;
    }
  }
  for (const s of plan.steps) s.apply();
  console.log('完成');
  return 0;
}

async function main(args: string[]): Promise<number> {
  const [cmd, ...rest] = args;
  if (cmd === 'init') {
    try {
      return await init(rest);
    } catch (err) {
      console.error(`aicode init 失败: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  // hook / commit：任何异常只记日志，退出码恒为 0，绝不阻塞 AI 工具或 git
  try {
    if (cmd === 'hook') {
      const phase = rest[0];
      const tool = rest[rest.indexOf('--tool') + 1];
      if ((phase === 'pre' || phase === 'post') && (tool === 'claude' || tool === 'codex')) {
        const text = await readStdin();
        runHook(phase, tool, text ? JSON.parse(text) : {});
      }
      return 0;
    }
    if (cmd === 'commit') {
      await runCommit(process.cwd());
      return 0;
    }
  } catch (err) {
    logError(cmd ?? 'cli', err);
    return 0;
  }
  console.log(USAGE);
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
```

- [ ] **Step 7: 运行全部测试，确认通过**

Run: `npm test`
Expected: tsc 成功，所有测试文件 PASS

- [ ] **Step 8: 性能抽查（对照 spec 12 节）**

Run：
```bash
cd "$(mktemp -d)" && git init -q && echo a > a.ts && git add -A && git -c user.name=t -c user.email=t@t commit -qm init
time (echo "{\"session_id\":\"p\",\"tool_use_id\":\"1\",\"cwd\":\"$PWD\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PWD/a.ts\"}}" | HOME="$(mktemp -d)" node /Users/yangxiaoyue/myfile/workspace/ai-project/gitlab-statistics/dist/cli.js hook pre --tool claude)
```
Expected：`real` < 0.15s（其中 Node 启动约占 50ms）。超出时在最终汇报中如实说明。

- [ ] **Step 9: 提交**

```bash
git add src/init.ts src/cli.ts tests/init.test.ts tests/e2e.test.ts
git commit -m "feat: 实现全局与项目模式 init、CLI 入口与端到端测试

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: MySQL Reporter（兼容 MySQL 5.6）

**Files:**
- Modify: `package.json`（新增依赖 `mysql2`）
- Create: `sql/schema.sql`
- Create: `src/reporter/mysql.ts`
- Modify: `src/reporter/index.ts`（`loadReporter` 支持 `type: 'mysql'`）
- Modify: `src/config.ts`（`ReporterConfig.type` 增加 `'mysql'`）
- Test: `tests/reporter-mysql.test.ts`

**Interfaces:**
- Consumes: `Reporter`（含可选 `close()`，见 Task 10）、`CommitEvent`、`repoKey`（git.ts）
- Produces（`src/reporter/mysql.ts`）：
  - `interface MysqlOptions { host: string; port: number; user: string; password?: string; database: string; connectTimeout: number }`
  - `interface SqlConnection { beginTransaction(): Promise<unknown>; commit(): Promise<unknown>; rollback(): Promise<unknown>; execute(sql: string, params: unknown[]): Promise<unknown>; end(): Promise<unknown> }`
  - `type ConnectionFactory = (opts: MysqlOptions) => Promise<SqlConnection>`
  - `INSERT_COMMIT_SQL`、`INSERT_FILE_SQL`、`INSERT_TOOL_SQL: string`
  - `toMysqlDatetime(iso: string): string`（转为 UTC `YYYY-MM-DD HH:MM:SS`）
  - `resolveMysqlOptions(options: Record<string, unknown>): MysqlOptions`（密码优先取环境变量 `AICODE_MYSQL_PASSWORD`）
  - `createMysqlReporter(options: Record<string, unknown>, factory?: ConnectionFactory): Reporter`

约束：
- `mysql2` 只能在 `src/reporter/mysql.ts` 中通过动态 `import('mysql2/promise')` 加载，而 `mysql.ts` 本身也只由 `loadReporter` 动态加载，保证 `hook` 路径不加载任何第三方代码
- 兼容 MySQL 5.6：不使用 JSON 列；索引键长度 ≤ 767 字节（仓库和路径用 ASCII 哈希列作主键，邮箱用 191 前缀索引）
- 只使用 `INSERT IGNORE`，客户端账号只需要 INSERT 权限；客户端不建表

- [ ] **Step 1: 安装依赖**

Run: `npm install mysql2@^3.11.0`
Expected：`package.json` 的 `dependencies` 中只有 `mysql2` 一项

- [ ] **Step 2: 编写建表脚本 `sql/schema.sql`**

```sql
-- aicode 统计表，兼容 MySQL 5.6 及以上版本（字符集 utf8mb4）。
-- 由 DBA 执行。客户端账号只需要 INSERT 权限，即使泄露也无法读取、修改或删除数据：
--   CREATE USER 'aicode_writer'@'%' IDENTIFIED BY '<密码>';
--   GRANT INSERT ON ai_stats.ai_commit      TO 'aicode_writer'@'%';
--   GRANT INSERT ON ai_stats.ai_commit_file TO 'aicode_writer'@'%';
--   GRANT INSERT ON ai_stats.ai_commit_tool TO 'aicode_writer'@'%';
-- MySQL 5.6 单列索引上限 767 字节，因此主键使用 ASCII 哈希列。

CREATE TABLE IF NOT EXISTS ai_commit (
  repo_key        CHAR(16)     CHARACTER SET ascii NOT NULL COMMENT 'repo 的 sha1 前 16 位',
  commit_sha      CHAR(40)     CHARACTER SET ascii NOT NULL,
  repo            VARCHAR(255) NOT NULL COMMENT '如 gitlab.example.com/group/project',
  branch          VARCHAR(255) NOT NULL,
  parent_sha      CHAR(40)     CHARACTER SET ascii NULL,
  commit_message  TEXT         NOT NULL,
  committed_at    DATETIME     NOT NULL COMMENT 'UTC',
  amend           TINYINT(1)   NOT NULL DEFAULT 0,
  owner_name      VARCHAR(128) NOT NULL,
  owner_email     VARCHAR(255) NOT NULL,
  module          VARCHAR(128) NOT NULL,
  added_total     INT          NOT NULL,
  added_ai        INT          NOT NULL,
  added_human     INT          NOT NULL,
  deleted_total   INT          NOT NULL,
  ai_ratio        DECIMAL(5,3) NOT NULL,
  ai_generated    INT          NOT NULL,
  ai_accept_rate  DECIMAL(5,3) NOT NULL,
  client_version  VARCHAR(32)  NOT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repo_key, commit_sha),
  KEY idx_repo_time (repo_key, committed_at),
  KEY idx_owner_time (owner_email(191), committed_at),
  KEY idx_module_time (module, committed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='每个 commit 的 AI 代码统计';

CREATE TABLE IF NOT EXISTS ai_commit_file (
  repo_key    CHAR(16)      CHARACTER SET ascii NOT NULL,
  commit_sha  CHAR(40)      CHARACTER SET ascii NOT NULL,
  path_sha1   CHAR(40)      CHARACTER SET ascii NOT NULL,
  path        VARCHAR(1024) NOT NULL,
  module      VARCHAR(128)  NOT NULL,
  added       INT           NOT NULL,
  ai          INT           NOT NULL,
  PRIMARY KEY (repo_key, commit_sha, path_sha1),
  KEY idx_module (module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='每个 commit 中各文件的统计';

CREATE TABLE IF NOT EXISTS ai_commit_tool (
  repo_key    CHAR(16)     CHARACTER SET ascii NOT NULL,
  commit_sha  CHAR(40)     CHARACTER SET ascii NOT NULL,
  tool        VARCHAR(32)  CHARACTER SET ascii NOT NULL COMMENT 'claude-code / codex',
  model       VARCHAR(128) CHARACTER SET ascii NOT NULL,
  ai          INT          NOT NULL COMMENT '被提交的 AI 行数',
  generated   INT          NOT NULL COMMENT 'AI 生成的行数',
  PRIMARY KEY (repo_key, commit_sha, tool, model)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='每个 commit 按工具/模型拆分的统计';
```

- [ ] **Step 3: 编写失败测试**

`tests/reporter-mysql.test.ts`：
```ts
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommitEvent } from '../src/events.js';
import { repoKey } from '../src/git.js';
import { loadReporter } from '../src/reporter/index.js';
import {
  createMysqlReporter, INSERT_COMMIT_SQL, INSERT_FILE_SQL, INSERT_TOOL_SQL, resolveMysqlOptions, toMysqlDatetime,
  type SqlConnection,
} from '../src/reporter/mysql.js';

const event: CommitEvent = {
  event_id: 'gitlab.example.com/g/p:' + 'a'.repeat(40),
  repo: 'gitlab.example.com/g/p',
  branch: 'feature/login',
  commit_sha: 'a'.repeat(40),
  parent_sha: null,
  commit_message: 'feat: 登录 🚀',
  committed_at: '2026-09-24T10:00:00+08:00',
  amend: true,
  owner: { name: '张三', email: 'z@example.com' },
  module: 'login',
  stats: {
    added_total: 3, added_ai: 2, added_human: 1, deleted_total: 0, ai_ratio: 0.667, ai_generated: 2, ai_accept_rate: 1,
    by_tool: { 'claude-code/claude-opus-5-5': { ai: 1, generated: 1 }, 'codex/gpt-5.6-luna': { ai: 1, generated: 1 } },
  },
  files: [{ path: 'src/a.ts', module: 'login', added: 3, ai: 2 }],
  client_version: '0.1.0',
};
const baseOptions = { host: 'db', user: 'aicode_writer', database: 'ai_stats', password: 'from-config' };

function fakeConnection(failOn?: string) {
  const calls: string[] = [];
  const executed: { sql: string; params: unknown[] }[] = [];
  const conn: SqlConnection = {
    beginTransaction: async () => calls.push('begin'),
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    execute: async (sql, params) => {
      if (failOn && sql === failOn) throw new Error('写入失败');
      executed.push({ sql, params });
      calls.push('execute');
    },
    end: async () => calls.push('end'),
  };
  return { conn, calls, executed };
}

afterEach(() => {
  delete process.env.AICODE_MYSQL_PASSWORD;
});

describe('参数解析', () => {
  it('ISO 时间转为 UTC DATETIME', () => {
    expect(toMysqlDatetime('2026-09-24T10:00:00+08:00')).toBe('2026-09-24 02:00:00');
  });

  it('密码优先取环境变量；缺少必填项时报错', () => {
    expect(resolveMysqlOptions(baseOptions)).toEqual({ ...baseOptions, port: 3306, connectTimeout: 5000 });
    process.env.AICODE_MYSQL_PASSWORD = 'from-env';
    expect(resolveMysqlOptions(baseOptions).password).toBe('from-env');
    expect(() => resolveMysqlOptions({ host: 'db' })).toThrow('host、user、database');
  });
});

describe('createMysqlReporter', () => {
  it('在一个事务内写入 commit、文件和工具三张表', async () => {
    const f = fakeConnection();
    const reporter = createMysqlReporter(baseOptions, async () => f.conn);
    await reporter.report(event);
    expect(f.calls).toEqual(['begin', 'execute', 'execute', 'execute', 'execute', 'commit']);
    const key = repoKey(event.repo);
    expect(f.executed[0]).toEqual({
      sql: INSERT_COMMIT_SQL,
      params: [
        key, event.commit_sha, event.repo, 'feature/login', null, 'feat: 登录 🚀', '2026-09-24 02:00:00', 1,
        '张三', 'z@example.com', 'login', 3, 2, 1, 0, 0.667, 2, 1, '0.1.0',
      ],
    });
    expect(f.executed[1]).toEqual({
      sql: INSERT_FILE_SQL,
      params: [key, event.commit_sha, createHash('sha1').update('src/a.ts').digest('hex'), 'src/a.ts', 'login', 3, 2],
    });
    expect(f.executed.slice(2)).toEqual([
      { sql: INSERT_TOOL_SQL, params: [key, event.commit_sha, 'claude-code', 'claude-opus-5-5', 1, 1] },
      { sql: INSERT_TOOL_SQL, params: [key, event.commit_sha, 'codex', 'gpt-5.6-luna', 1, 1] },
    ]);
  });

  it('所有语句都用 INSERT IGNORE，保证重复上报幂等', () => {
    for (const sql of [INSERT_COMMIT_SQL, INSERT_FILE_SQL, INSERT_TOOL_SQL]) expect(sql.startsWith('INSERT IGNORE INTO ')).toBe(true);
  });

  it('写入失败时回滚并抛出，让事件留待下次补发', async () => {
    const f = fakeConnection(INSERT_FILE_SQL);
    const reporter = createMysqlReporter(baseOptions, async () => f.conn);
    await expect(reporter.report(event)).rejects.toThrow('写入失败');
    expect(f.calls).toEqual(['begin', 'execute', 'rollback']);
  });

  it('多个事件共用一个连接，close 时关闭', async () => {
    const f = fakeConnection();
    let created = 0;
    const reporter = createMysqlReporter(baseOptions, async () => {
      created++;
      return f.conn;
    });
    await reporter.report(event);
    await reporter.report({ ...event, commit_sha: 'b'.repeat(40) });
    await reporter.close?.();
    expect(created).toBe(1);
    expect(f.calls.at(-1)).toBe('end');
  });

  it('loadReporter 支持 type=mysql，且在首次 report 前不建立连接', async () => {
    const reporter = await loadReporter({ type: 'mysql', options: baseOptions });
    expect(reporter.name).toBe('mysql');
    await reporter.close?.();
  });
});

// 仅在提供测试库时运行，例如：AICODE_TEST_MYSQL_URL=mysql://root:pwd@127.0.0.1:3306/ai_stats_test
const url = process.env.AICODE_TEST_MYSQL_URL;
describe.skipIf(!url)('真实 MySQL 集成', () => {
  it('建表后重复上报同一事件，只保留一行', async () => {
    const mysql = await import('mysql2/promise');
    const admin = await mysql.createConnection({ uri: url!, multipleStatements: true });
    await admin.query('DROP TABLE IF EXISTS ai_commit, ai_commit_file, ai_commit_tool');
    await admin.query(fs.readFileSync(path.resolve('sql/schema.sql'), 'utf8'));
    const u = new URL(url!);
    const reporter = createMysqlReporter({
      host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database: u.pathname.slice(1),
    });
    await reporter.report(event);
    await reporter.report(event);
    await reporter.close?.();
    const [rows] = await admin.query('SELECT COUNT(*) AS n FROM ai_commit');
    const [tools] = await admin.query('SELECT COUNT(*) AS n FROM ai_commit_tool');
    await admin.end();
    expect((rows as { n: number }[])[0].n).toBe(1);
    expect((tools as { n: number }[])[0].n).toBe(2);
  });
});
```

- [ ] **Step 4: 运行测试，确认失败**

Run: `npx vitest run tests/reporter-mysql.test.ts`
Expected: FAIL，提示无法解析 `../src/reporter/mysql.js`

- [ ] **Step 5: 实现 src/reporter/mysql.ts**

```ts
import { createHash } from 'node:crypto';
import type { CommitEvent } from '../events.js';
import { repoKey } from '../git.js';
import type { Reporter } from './index.js';

export interface MysqlOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  connectTimeout: number;
}

/** 只声明用到的方法，便于测试注入假连接 */
export interface SqlConnection {
  beginTransaction(): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
  execute(sql: string, params: unknown[]): Promise<unknown>;
  end(): Promise<unknown>;
}
export type ConnectionFactory = (opts: MysqlOptions) => Promise<SqlConnection>;

// 只用 INSERT IGNORE：重复上报幂等，且客户端账号只需 INSERT 权限
export const INSERT_COMMIT_SQL =
  'INSERT IGNORE INTO ai_commit (repo_key, commit_sha, repo, branch, parent_sha, commit_message, committed_at, amend, ' +
  'owner_name, owner_email, module, added_total, added_ai, added_human, deleted_total, ai_ratio, ai_generated, ' +
  'ai_accept_rate, client_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
export const INSERT_FILE_SQL =
  'INSERT IGNORE INTO ai_commit_file (repo_key, commit_sha, path_sha1, path, module, added, ai) VALUES (?, ?, ?, ?, ?, ?, ?)';
export const INSERT_TOOL_SQL =
  'INSERT IGNORE INTO ai_commit_tool (repo_key, commit_sha, tool, model, ai, generated) VALUES (?, ?, ?, ?, ?, ?)';

export function toMysqlDatetime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
}

export function resolveMysqlOptions(options: Record<string, unknown>): MysqlOptions {
  const { host, user, database, port, password } = options;
  if (typeof host !== 'string' || typeof user !== 'string' || typeof database !== 'string') {
    throw new Error('mysql reporter 需要配置 host、user、database');
  }
  return {
    host,
    user,
    database,
    port: typeof port === 'number' ? port : 3306,
    password: process.env.AICODE_MYSQL_PASSWORD ?? (typeof password === 'string' ? password : undefined),
    connectTimeout: 5000,
  };
}

const defaultFactory: ConnectionFactory = async (o) => {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({ ...o, charset: 'utf8mb4' });
  return conn as unknown as SqlConnection;
};

export function createMysqlReporter(options: Record<string, unknown>, factory: ConnectionFactory = defaultFactory): Reporter {
  const opts = resolveMysqlOptions(options);
  let conn: SqlConnection | null = null;
  return {
    name: 'mysql',
    async report(e: CommitEvent) {
      conn ??= await factory(opts);
      const key = repoKey(e.repo);
      const s = e.stats;
      await conn.beginTransaction();
      try {
        await conn.execute(INSERT_COMMIT_SQL, [
          key, e.commit_sha, e.repo, e.branch, e.parent_sha, e.commit_message, toMysqlDatetime(e.committed_at),
          e.amend ? 1 : 0, e.owner.name, e.owner.email, e.module, s.added_total, s.added_ai, s.added_human,
          s.deleted_total, s.ai_ratio, s.ai_generated, s.ai_accept_rate, e.client_version,
        ]);
        for (const f of e.files) {
          const pathSha1 = createHash('sha1').update(f.path).digest('hex');
          await conn.execute(INSERT_FILE_SQL, [key, e.commit_sha, pathSha1, f.path, f.module, f.added, f.ai]);
        }
        for (const [toolModel, t] of Object.entries(s.by_tool)) {
          const slash = toolModel.indexOf('/');
          await conn.execute(INSERT_TOOL_SQL, [key, e.commit_sha, toolModel.slice(0, slash), toolModel.slice(slash + 1), t.ai, t.generated]);
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback().catch(() => undefined);
        throw err;
      }
    },
    async close() {
      if (conn) {
        await conn.end();
        conn = null;
      }
    },
  };
}
```

- [ ] **Step 6: 接入 loadReporter 与配置类型**

`src/config.ts` 中把：
```ts
export interface ReporterConfig { type: 'noop' | 'module'; module?: string; options?: Record<string, unknown> }
```
改为：
```ts
export interface ReporterConfig { type: 'noop' | 'module' | 'mysql'; module?: string; options?: Record<string, unknown> }
```

`src/reporter/index.ts` 中把 `loadReporter` 替换为：
```ts
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
```

- [ ] **Step 7: 运行测试，确认通过；确认 hook 路径不加载 mysql2**

Run: `npx vitest run tests/reporter-mysql.test.ts tests/reporter.test.ts && npm run build && grep -l "mysql2" dist/*.js dist/agents/*.js || echo "hook 路径未引用 mysql2"`
Expected：测试 PASS（集成测试在未设置 `AICODE_TEST_MYSQL_URL` 时显示 skipped）；最后输出"hook 路径未引用 mysql2"。`mysql2` 只允许出现在 `dist/reporter/mysql.js` 中。

- [ ] **Step 8: 提交**

```bash
git add package.json package-lock.json sql/schema.sql src/reporter src/config.ts tests/reporter-mysql.test.ts
git commit -m "feat: 新增兼容 MySQL 5.6 的数据库上报

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: 真机验证与使用文档

**Files:**
- Create: `README.md`

- [ ] **Step 1: 编写 README**

`README.md`：
````markdown
# aicode

统计 Claude Code、Codex 等 AI 编码工具在每个 git commit 中的**有效代码量**：只有 AI 写入且最终被提交的行才计为 AI 行，被人工改过的行计为人工行。统计结果汇总在本机 `~/.aicode/events.jsonl`，并通过可扩展的 Reporter 上报（默认不上报）。

## 安装

```bash
npm install -g .                 # 在本仓库目录执行（需先 npm run build）

# 全局模式：覆盖本机所有仓库（改动 ~/.claude/settings.json、~/.codex/config.toml、全局 core.hooksPath）
aicode init
aicode init --uninstall

# 项目模式：只作用于当前仓库（改动 .claude/settings.local.json、.codex/config.toml、.git/hooks/post-commit）
cd your-repo && aicode init --project
aicode init --project --uninstall
```

`init` 会先列出将要改动的文件并请求确认，加 `--yes` 可跳过确认。已存在的文件会先备份为 `*.aicode.bak`。项目模式写入的配置文件会加入 `.git/info/exclude`，不会出现在 `git status` 中；如果这些文件已被仓库跟踪，则不会修改。两种模式可以同时安装，不会重复计数。

## 配置 `~/.aicode/config.json`

```json
{
  "owner": { "name": "张三", "email": "zhangsan@example.com" },
  "modules": [{ "path": "src/user/**", "name": "user-center" }],
  "ignore": ["docs/generated/**"],
  "reporter": { "type": "module", "module": "/abs/path/my-reporter.mjs", "options": { "url": "https://gw/api" } }
}
```

仓库根目录的 `.aicode.json` 可以覆盖 `owner`、`modules`、`ignore`；`reporter` 只从全局配置读取。

## 上报到 MySQL（5.6 及以上）

1. 由 DBA 执行 `sql/schema.sql` 建表，并创建一个**只有 INSERT 权限**的账号（脚本开头有示例）
2. 在 `~/.aicode/config.json` 中配置：

```json
{
  "reporter": {
    "type": "mysql",
    "options": { "host": "db.example.com", "port": 3306, "user": "aicode_writer", "database": "ai_stats" }
  }
}
```

3. 密码优先从环境变量 `AICODE_MYSQL_PASSWORD` 读取，也可以写在 `options.password` 中（`init` 已把配置文件权限设为 600）。注意：commit 统计由 git hook 在后台触发，从 GUI git 客户端提交时可能读不到 shell 中设置的环境变量；这种情况下请把密码写进配置文件

数据库不可达时，事件保留在本地，下次 commit 时补发（每次最多 50 条），不会阻塞 git。

## 自定义 Reporter

```js
// my-reporter.mjs
export default (options) => ({
  name: 'gateway',
  async report(event) {
    const res = await fetch(options.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // 抛错后该事件保留，下次 commit 时补发
  },
});
```

## 数据文件

| 路径 | 内容 |
|---|---|
| `~/.aicode/events.jsonl` | 每个 commit 一条统计事件 |
| `~/.aicode/ledger/*.jsonl` | 待匹配的 AI 行指纹（不含代码原文） |
| `~/.aicode/logs/aicode.log` | 错误日志 |

## 已知限制

- 仓库级设置了 `core.hooksPath` 的仓库（如 husky v5+）不会触发统计
- 项目模式下，Codex 只会加载已信任项目的 `.codex/config.toml`；未信任的项目只统计 Claude Code
- 项目模式安装 Codex 时，Codex 只认全局配置中的信任记录，因此会在 `~/.codex/config.toml` 追加该项目的信任区块（卸载时删除）
- 上报只在 commit 时触发；长时间没有 commit 时，积压的事件不会主动补发
- AI 执行 shell 命令期间，人工对同一仓库的改动会被计为 AI 改动
- rebase / squash / cherry-pick 后不迁移归属；amend 会生成一条 `amend: true` 的新事件
````

- [ ] **Step 2: 在真实环境安装（需先征得用户同意）**

这一步会修改用户真实的 `~/.claude/settings.json`、`~/.codex/config.toml` 和全局 git 配置（都会先备份为 `*.aicode.bak`）。**执行前先询问用户**，得到同意后再运行：

```bash
npm run build && npm install -g . && aicode init
```
`init` 会列出改动并请求确认，由用户在终端里亲自输入 `y`。
Expected：输出改动清单和"完成"，退出码为 0

- [ ] **Step 3: 真机验证 Claude Code 与 Codex**

在一个临时 git 仓库中：
1. 用 Claude Code 让 AI 新建一个 10 行左右的文件，手动改掉其中 1 行后 `git commit`
2. 用 Codex 让 AI 通过 shell 命令追加 3 行到另一个文件，然后 `git commit`
3. 运行 `tail -n 2 ~/.aicode/events.jsonl`

Expected：第 1 个事件的 `added_ai` 等于"AI 生成的有效行数 − 1"，`by_tool` 中出现 `claude-code/<模型名>`；第 2 个事件的 `added_ai` = 3，`by_tool` 中出现 `codex/<模型名>`；`~/.aicode/logs/aicode.log` 中没有新增错误。任何一项不符合，都按 superpowers:systematic-debugging 排查，并如实报告。

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: 新增 aicode 使用说明

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

# aicode 补充：统计名单、MySQL 配置向导、同步与状态 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 在已完成的 aicode 上增加：全局安装下的统计名单（track/untrack）、交互式 MySQL 配置向导、`aicode sync` / `aicode status` 与提交时自动补发的失败退避。

**Architecture:** 名单与同步状态都只在全局 `~/.aicode/` 下；新增 `src/track.ts`、`src/sync.ts`、`src/configure.ts` 三个模块，CLI 在 `src/cli.ts` 分发。钩子路径只增加一次读取全局配置的判断，不引入第三方依赖。

**Tech Stack:** 同主计划（TypeScript ESM、Node ≥ 18 内置模块、mysql2 仅在 reporter/mysql 与配置向导的连接测试中动态加载、vitest）。

**Spec:** `docs/superpowers/specs/2026-09-24-aicode-stats-design.md` 第 13 节（本计划的约束来源），其余章节仍然有效。

## Global Constraints

- 与主计划相同：`hook`/`commit` 子命令异常只写日志、退出码恒为 0；测试一律 `tmpHome()` 隔离，不得触碰用户真实 `~/.claude`、`~/.codex`、全局 git 配置和真实 `~/.aicode`
- 运行时依赖仍只有 `mysql2`，且只能动态 `import()`；钩子路径（`src/hook.ts` 及其导入链）不得静态导入 mysql2
- 写全局配置必须保留未知字段、文件权限 600（目录 700）
- 输出与日志中不得出现 MySQL 密码
- 代码注释与用户提示用中文；commit message `<type>: <中文描述>`，署名按各自会话提示
- 完成后必须 `npm run build`：用户已安装的钩子直接执行本仓库 `dist/cli.js`

---

### Task 1: 统计名单 track/untrack

**Files:**
- Modify: `src/config.ts`（`AicodeConfig` 增加 `track`；新增 `readGlobalConfig()`、`updateGlobalConfig()`）
- Create: `src/track.ts`
- Modify: `src/hook.ts`（pre 阶段对未跟踪仓库直接跳过）、`src/commit.ts`（未跟踪仓库返回 null）、`src/init.ts`（`--local` 安装/卸载时加入/移出名单）、`src/cli.ts`（`track` / `untrack` 子命令与 USAGE）
- Test: `tests/track.test.ts`，并在 `tests/hook.test.ts`、`tests/commit.test.ts`、`tests/init.test.ts`、`tests/e2e.test.ts` 各补一个用例

**Interfaces（Produces）:**
- `config.ts`：`interface TrackConfig { mode: 'all' | 'list'; repos: string[] }`；`AicodeConfig.track: TrackConfig`（`loadConfig` 只从全局读取，缺省 `{ mode: 'all', repos: [] }`，字段类型错误时 logError 并用缺省）；`readGlobalConfig(): Record<string, unknown>`（原样读取，文件不存在或损坏返回 `{}`）；`updateGlobalConfig(mutate: (raw: Record<string, unknown>) => void): void`（读→改→写，保留未知字段，确保目录存在且 700、文件 600）
- `track.ts`：`isRepoTracked(root: string): boolean`（mode=all 恒 true；list 时 `repoId(root)` 在 repos 中）；`trackRepo(root: string): { id: string; switched: boolean }`（加入名单、去重、mode 设为 list；`switched` 表示本次从 all 切到 list）；`untrackRepo(root: string): { id: string; removed: boolean }`；`addToTrackList(root)` / `removeFromTrackList(root)`（只增删名单、不改 mode，供 `init --local` 用）；`setTrackAll(): void`；`describeTrack(): string`（多行中文，列出模式与名单）

**行为要求:**
- `hook.ts`：在 `locate()` 和 `shellBaseline()` 得到仓库根后，若 `!isRepoTracked(root)` 则返回 null（从而 pre 不存基线，post 的回退路径也不记录）
- `commit.ts`：`repoRoot` 之后立即 `if (!isRepoTracked(root)) return null`
- `init.ts`：`planProject` 安装时追加一步"把当前仓库加入统计名单（名单模式下生效）"→ `addToTrackList(root)`；卸载时追加"移出统计名单"→ `removeFromTrackList(root)`
- `cli.ts`：
  - `aicode track`：不在 git 仓库时 stderr 提示并退出 1；成功打印"已加入统计名单：<id>"，`switched` 时再打印"现在只统计名单中的仓库（aicode track --all 可恢复统计全部）"
  - `aicode untrack`：同上，打印"已移出统计名单：<id>"或"该仓库不在名单中"
  - `aicode track --all`：打印"已恢复统计所有仓库"
  - `aicode track --list`：打印 `describeTrack()`
  - 未知参数报错退出 1；这些子命令失败退出 1（它们是用户命令，不属于 hook/commit）
  - USAGE 增加对应行

**必需测试（先写、先看失败）:**
1. `updateGlobalConfig` 保留未知字段（如 `reporter`、自定义 `foo`），写后权限为 600
2. `trackRepo` 从 all 切到 list，`switched` 为 true；再次 track 同一仓库不重复、`switched` 为 false
3. `isRepoTracked`：all 下任意仓库 true；list 下名单内 true、名单外 false
4. `untrackRepo` 移出；`setTrackAll` 后名单外仓库也为 true
5. 仓库级 `.aicode.json` 写 `track` 不生效
6. hook：list 模式下名单外仓库的 Claude Edit pre/post 不产生 pending、不写 ledger；名单内仓库照常记录
7. commit：list 模式下名单外仓库 `runCommit` 返回 null 且不写 events
8. init：`planProject` 安装后名单含该仓库、mode 不变；卸载后名单不含
9. e2e：`aicode track` 在临时仓库中退出 0 且输出"已加入统计名单"；`aicode track --list` 输出含该仓库 id；`aicode untrack` 后 `--list` 不含

- [ ] 写测试 → 确认失败 → 实现 → `npm test` 全绿 → `npm run build` → 提交 `feat: 新增统计名单 track/untrack，全局安装下可只统计指定仓库`

---

### Task 2: 同步与状态（sync / status / 退避）

**Files:**
- Modify: `src/reporter/index.ts`（`flushEvents` 返回结果）
- Create: `src/sync.ts`
- Modify: `src/commit.ts`（改为调用 `autoSync`）、`src/events.ts`（新增 `countUnreported()`）、`src/paths.ts`（新增 `syncStatePath()`）、`src/cli.ts`（`sync` / `status` 子命令与 USAGE）
- Test: `tests/sync.test.ts`，e2e 补用例

**Interfaces:**
- `paths.ts`：`syncStatePath = () => <aicodeHome>/sync-state.json`
- `events.ts`：`countUnreported(): number`
- `reporter/index.ts`：`interface FlushResult { sent: number; failed: boolean; error?: string }`；`flushEvents(reporter, limit = 50): Promise<FlushResult>`（行为不变：遇错停止、finally 调 close；error 为错误消息文本，不得包含密码——mysql2 的错误消息本身不含密码，直接用 `err.message`）
- `sync.ts`：
  - `interface SyncState { lastAttemptAt?: string; lastSuccessAt?: string; lastError?: string; consecutiveFailures: number; nextRetryAt?: string }`（时间为 ISO 字符串）
  - `readSyncState(): SyncState`、`writeSyncState(s: SyncState): void`
  - `backoffMs(failures: number): number` = `min(2^(failures-1), 30) * 60_000`（failures ≥ 1）
  - `syncAll(reporter: Reporter, now?: () => number): Promise<{ sent: number; remaining: number; error?: string }>`：循环 `flushEvents(reporter, 50)` 直到某批 `sent === 0 && !failed`（队列空）或 `failed`；更新 SyncState（成功：consecutiveFailures=0、lastSuccessAt、清 lastError/nextRetryAt；失败：+1、lastError、nextRetryAt=now+backoff）。注意 `flushEvents` 每批都会调用 `reporter.close()`，mysql reporter 下一批会重新连接——可接受
  - `autoSync(reporter: Reporter, now?: () => number): Promise<void>`：若 `nextRetryAt` 存在且 `now < nextRetryAt` 则直接返回（不尝试）；否则只发一批（`flushEvents(reporter, 50)`）并按同样规则更新 SyncState
  - `describeStatus(config: AicodeConfig): string`：多行中文——统计模式与名单（复用 Task 1 的 `describeTrack()`）、reporter 类型（mysql 时 `host:port/database user=...`，绝不含密码）、积压条数、最近尝试/成功时间、最近错误、下次允许自动补发时间
- **noop 不消费队列（控制器裁定，spec 13.3 同步修订）**：`syncAll` 与 `autoSync` 在 `reporter.name === 'noop'` 时直接返回（sent=0、不调用 flushEvents、不标记已上报、不改 SyncState），使未配置上报期间的事件保留在本地，配置 MySQL 后可全部补发。`flushEvents` 本身行为不变
- `commit.ts`：末尾 `await flushEvents(await loadReporter(config.reporter))` 改为 `await autoSync(await loadReporter(config.reporter))`
- `cli.ts`：
  - `aicode sync`：`loadConfig(null)` 取全局 reporter → `syncAll` → 打印"已上报 N 条，剩余 M 条"，失败时再打印"失败原因：…"；全部成功退出 0，否则 1；reporter 为 noop 时打印"未配置上报（reporter=noop），N 条事件保留在本地队列，配置后执行 aicode sync 即可补发"并退出 0
  - `aicode status`：打印 `describeStatus(loadConfig(null))`，退出 0

**必需测试:**
1. `flushEvents` 返回 `{ sent, failed }` 正确（成功 2 条；第二条失败时 sent=1、failed=true、error 为消息）
2. `syncAll` 对 120 条事件分三批全部发送，remaining=0，状态 consecutiveFailures=0
3. `syncAll` 失败时状态 consecutiveFailures 递增、nextRetryAt = now + backoff（用注入的 `now`）
4. `backoffMs`：1→1 分钟、2→2、3→4、6→30、10→30
5. `autoSync` 在 `now < nextRetryAt` 时不调用 reporter.report；到期后调用，成功则清零
6. `describeStatus` 在 mysql 配置下不包含密码字符串，包含 host 与积压条数
7. noop 时 `syncAll`/`autoSync` 不标记任何事件为已上报（`countUnreported` 不变）
8. e2e：`aicode status` 退出 0 且输出含"积压"；配置一个必然失败的 module reporter（临时目录中写 `.mjs`，report 抛错）后 `aicode sync` 退出 1 且输出含"失败原因"

- [ ] 写测试 → 失败 → 实现 → `npm test` → `npm run build` → 提交 `feat: 新增 aicode sync / status，提交时自动补发增加失败退避`

---

### Task 3: MySQL 配置向导 `aicode config mysql`

**Files:**
- Create: `src/configure.ts`
- Modify: `src/cli.ts`（`config mysql [--disable]` 与 USAGE）
- Test: `tests/configure.test.ts`

**Interfaces:**
- `configure.ts`：
  - `interface Prompter { ask(question: string, def?: string): Promise<string>; askSecret(question: string): Promise<string>; confirm(question: string): Promise<boolean> }`
  - `createTtyPrompter(): Prompter`：基于 readline；`ask` 显示默认值 `（默认 xxx）`，空输入返回默认值；`askSecret` 输入不回显（例如临时替换 readline 的 `_writeToOutput` 或使用 raw mode 自行读取，回车结束，支持退格）；`confirm` 接受 y/yes
  - `interface MysqlProbe { connect(opts: MysqlOptions): Promise<{ query(sql: string): Promise<unknown[]>; end(): Promise<void> }> }`，默认实现动态 `import('mysql2/promise')`，`createConnection({ ...opts, connectTimeout: 5000 })`，`query` 返回 rows
  - `hasInsertGrant(grants: string[], database: string): boolean`：任一行满足：`GRANT ALL PRIVILEGES ON *.*` / `` ON `db`.* `` / `ON db.*`，或含 `INSERT` 且作用于 `*.*`、`db.*`、或三张表（`ai_commit`、`ai_commit_file`、`ai_commit_tool`）全部各有 INSERT；大小写不敏感，反引号可有可无
  - `testMysql(opts, probe): Promise<{ ok: boolean; message: string }>`：连接 → `SELECT 1` → `SHOW GRANTS FOR CURRENT_USER()`（取每行第一个字段值）→ `hasInsertGrant`；任何一步失败返回 `ok:false` 与中文原因（不含密码）；finally 关闭连接
  - `runMysqlWizard(prompter: Prompter, probe: MysqlProbe): Promise<number>`：读取现有全局 reporter（type=mysql 时取其 options 作为默认值）→ 依次 ask host（必填）、port（默认 3306，需为 1–65535 整数，否则重问一次后报错退出 1）、database（必填）、user（必填）、askSecret password（为空且已有原密码时沿用原密码）→ 打印"正在测试连接…" → `testMysql` → 成功打印"连接成功，已具备 INSERT 权限"；失败打印原因并 `confirm('仍然保存？[y/N] ')`，否则退出 1 不保存 → 保存：`updateGlobalConfig(raw => raw.reporter = { type: 'mysql', options: { host, port, user, password, database } })` → 打印"已保存到 ~/.aicode/config.json（权限 600）"，返回 0
  - `disableMysql(): void`：`updateGlobalConfig(raw => raw.reporter = { type: 'noop' })`
- `cli.ts`：`aicode config mysql` 在 `!process.stdin.isTTY` 时 stderr"请在交互终端中运行 aicode config mysql"并退出 1；否则 `runMysqlWizard(createTtyPrompter(), defaultProbe)`；`aicode config mysql --disable` 调 `disableMysql()` 打印"已关闭 MySQL 上报"退出 0；其他参数报错退出 1

**必需测试（用假 Prompter 与假 Probe）:**
1. `hasInsertGrant`：`GRANT INSERT ON \`ai_stats\`.* TO ...` → true；`GRANT ALL PRIVILEGES ON *.* ...` → true；三张表分别 INSERT → true；只有两张表 → false；`GRANT SELECT ON ai_stats.*` → false；其他库 → false
2. `testMysql`：连接抛错 → ok=false，message 含原因且不含密码；无 INSERT 权限 → ok=false；正常 → ok=true；各情况都调用了 end
3. `runMysqlWizard` 成功路径：写入全局配置 reporter=mysql 且 options 正确，保留其他字段，文件权限 600
4. 已有配置时回车沿用默认值（包括密码为空沿用原密码）
5. 测试失败且 confirm=false → 返回 1、配置未改；confirm=true → 保存
6. port 非法两次 → 返回 1、配置未改
7. `disableMysql` 把 reporter 改为 noop 并保留其他字段
8. 输出（收集 Prompter 与 console 的内容）中不出现密码

- [ ] 写测试 → 失败 → 实现 → `npm test` → `npm run build` → 提交 `feat: 新增 aicode config mysql 交互式配置向导`

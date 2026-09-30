# aicode

统计 Claude Code、Codex 等 AI 编码工具在每个 git commit 中的**有效代码量**：只有 AI 写入且最终被提交的行才计为 AI 行，被人工改过的行计为人工行。统计结果汇总在本机 `~/.aicode/events.jsonl`，并通过可扩展的 Reporter 上报（默认不上报）。

## 安装

```bash
npm install -g .                 # 在本仓库目录执行（需先 npm run build）

# 全局模式：覆盖本机所有仓库（改动 ~/.claude/settings.json、~/.codex/config.toml、全局 core.hooksPath）
aicode init
aicode init --uninstall

# 项目模式：只作用于当前仓库（改动 .claude/settings.local.json、.codex/config.toml、.git/hooks/post-commit）
cd your-repo && aicode init --local
aicode init --local --uninstall
```

`init` 会先列出将要改动的文件并请求确认，加 `--yes` 可跳过确认。已存在的文件会先备份为 `*.aicode.bak`。项目模式写入的配置文件会加入 `.git/info/exclude`，不会出现在 `git status` 中；如果这些文件已被仓库跟踪，则不会修改。两种模式可以同时安装，不会重复计数。

## 统计名单：`aicode track` / `untrack`

`aicode init` 是全局安装（覆盖本机所有仓库）；统计名单决定全局安装下**具体统计哪些仓库**，名单只存在全局配置 `~/.aicode/config.json` 的 `track` 字段中：

```bash
cd your-repo && aicode track        # 把当前仓库加入名单，并把统计模式切到"仅名单"
aicode untrack                      # 把当前仓库移出名单（不改变统计模式）
aicode track --all                  # 恢复统计所有仓库（清除"仅名单"限制，名单本身不清空）
aicode track --list                 # 查看当前统计模式与名单
```

- 首次执行 `aicode track` 会把统计模式从"全部仓库"切到"仅名单"，之后未加入名单的仓库不再被统计（钩子直接跳过、不记录基线，commit 时也不生成事件）。
- `aicode init --local` 安装到某仓库时，会自动把该仓库加入名单（仅在名单模式下才生效，不会主动切换模式）；`--local --uninstall` 卸载时会把它移出名单。
- `track` / `untrack` / `track --list` 都只读写全局配置，与是否用了 `--local` 无关。

## `aicode sync`：手动补发本地积压事件

未配置上报（reporter 为默认的 noop）或数据库暂时不可达时，采集到的事件会保留在本地队列（`~/.aicode/events.jsonl`）。配置好上报后，执行：

```bash
aicode sync
```

会立即尝试把队列中的事件全部发送出去，并打印已上报/剩余条数；失败时打印失败原因并以非 0 退出。

## `aicode status`：查看统计模式、reporter 与同步状态

```bash
aicode status
```

输出当前统计模式（全部 / 仅名单及名单内容）、reporter 配置（不含密码）、本地积压事件数、最近一次补发尝试/成功时间，以及（如果处于失败退避中）下次自动补发时间。

## `aicode config mysql`：交互式配置 MySQL 上报

```bash
aicode config mysql            # 交互式配置向导：依次询问 host/port/database/user/密码，测试连接后保存
aicode config mysql --disable  # 关闭 MySQL 上报（reporter 改回 noop）
```

- 密码输入不回显、不进入终端输入历史。
- 向导会先尝试连接并执行 `SHOW GRANTS FOR CURRENT_USER()`，确认账号具备写入所需的 INSERT 权限；测试失败时会询问是否仍然保存。
- 配置保存到 `~/.aicode/config.json`（文件权限 600），保留其他既有字段（如 `owner`、`modules`）。
- 若设置了环境变量 `AICODE_MYSQL_PASSWORD`，向导会提示"上报时将优先使用它"并跳过密码询问，用它来做连接测试；该值不会被写入配置文件（与内置 MySQL Reporter 读取密码的优先级一致）。

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

数据库不可达时，事件保留在本地队列，可随时执行 `aicode sync` 手动补发；commit 时也会自动尝试补发一批（每次最多 50 条），失败后按 1→2→4→…→30 分钟递增退避，退避期内的 commit 不会重复尝试，不会阻塞 git。

## 自定义 Reporter

```js
// my-reporter.mjs
export default (options) => ({
  name: 'gateway',
  async report(event) {
    const res = await fetch(options.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // 抛错后该事件保留，下次 commit 时按退避重试，或执行 aicode sync 立即补发
  },
});
```

**Reporter 必须按 `event_id` 幂等**：在极少数情况下（例如上报成功后写"已上报"标记时磁盘出错），同一事件可能被再次上报，接收方需按 `event_id` 去重（内置 MySQL Reporter 通过主键 + `INSERT IGNORE` 保证）。

## 数据文件

| 路径 | 内容 |
|---|---|
| `~/.aicode/events.jsonl` | 每个 commit 一条统计事件 |
| `~/.aicode/ledger/*.jsonl` | 待匹配的 AI 行指纹（不含代码原文） |
| `~/.aicode/logs/aicode.log` | 错误日志 |
| `~/.aicode/sync-state.json` | 补发同步状态（最近尝试/成功时间、连续失败次数、下次重试时间） |

## 已知限制

- 仓库级设置了 `core.hooksPath` 的仓库（如 husky v5+）不会触发统计
- 项目模式下，Codex 只会加载已信任项目的 `.codex/config.toml`；未信任的项目只统计 Claude Code
- 项目模式安装 Codex 时，Codex 只认全局配置中的信任记录，因此会在 `~/.codex/config.toml` 追加该项目的信任区块（卸载时删除）
- 自动补发只在 commit 时触发（受退避控制），也可随时执行 aicode sync
- AI 执行 shell 命令期间，人工对同一仓库的改动会被计为 AI 改动
- rebase / squash / cherry-pick 后不迁移归属；amend 会生成一条 `amend: true` 的新事件
- 全局模式设置了 `core.hooksPath` 后，`pre-commit`（Python 框架）会拒绝执行 `pre-commit install`；需要先 `aicode init --uninstall` 或手动处理
- 钩子脚本里写死了安装时的 node 绝对路径；升级或切换 node（如用 nvm）后，需要重新执行一次 `aicode init` 才能生效

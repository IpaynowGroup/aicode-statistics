# AI Coding 有效代码量统计工具（aicode）设计

日期：2026-09-24

## 1. 目标

为 Claude Code、Codex CLI 等 AI 编码工具提供整机级实时统计：每次 git commit 时计算其中 **AI 生成且最终被提交的有效代码行数**，附带负责人、功能模块、commit 信息，汇总到本机全局存储，并通过可扩展的 `Reporter` 接口上报（默认空实现）。

设计原则：**轻量**——无常驻进程、不阻塞 AI 工具和 git、不存代码原文；运行时依赖只有 MySQL 驱动 `mysql2` 一项，且仅在上报时动态加载，钩子路径零依赖。

### 范围内
- 本地 CLI `aicode`（TypeScript 编译为 JS，Node ≥ 18，npm 分发，仅使用 Node 内置模块；兼容 git ≥ 2.15）
- Claude Code、Codex CLI 的钩子采集，覆盖文件编辑工具和 shell 工具
- 全局 git hook 触发的 commit 统计
- `Reporter` 扩展接口，默认 `NoopReporter`；内置 MySQL（5.6 及以上）直连上报

### 范围外（后续迭代）
- HTTP 网关上报实现、定时补发（上报只在 commit 时触发）
- 服务端存储、看板、跨机器汇总
- 工号 / LDAP 对接
- rebase / squash / cherry-pick 后的归属迁移
- prompt 存储、AI blame

## 2. 借鉴 git-ai 的设计取舍

参考开源项目 [git-ai](https://github.com/git-ai-project/git-ai)（Apache-2.0，Rust）的采集实现，逐项决定是否采纳：

| git-ai 的做法 | 是否采纳 | 说明 |
|---|---|---|
| **Pre/Post 成对检查点**：`PreToolUse` 时记录文件当前状态作为基线，`PostToolUse` 时与基线对比，差异计为 AI 改动 | ✅ 采纳 | 不再依赖各工具的参数格式（`new_string`、`apply_patch` 等），统一对比文件的真实内容，比从工具参数里提取更准确。原设计中解析 Codex 会话日志 `FileChange` 的方案因此取消 |
| **Shell 工具的快照对比**：执行 Bash 前后各做一次文件状态快照，找出被改动的文件 | ✅ 采纳（简化） | 补上原设计 3.2 节中"AI 用 shell 写文件"的漏计。git-ai 靠常驻进程加文件遍历实现；我们改用 `git status` 结合文件的 mtime/size，不引入常驻进程 |
| **时间预算与规模上限**：遍历超过 1.5s 或文件超过 5 万个就放弃，整个钩子最长 4s | ✅ 采纳 | 保证大仓库下也不会拖慢 AI 工具 |
| **默认忽略生成类文件**：lock 文件、`*.min.js`、`vendor/`、protobuf 生成代码，以及 `.gitattributes` 中标记为 `linguist-generated` 的文件 | ✅ 采纳 | 避免 AI 顺带更新 lock 文件，把 AI 代码量虚高几千行 |
| **区分生成量和采纳量**：统计 AI 生成了多少行、其中多少行被原样提交 | ✅ 采纳 | 新增 `ai_generated` 指标，可以算出 AI 代码的采纳率 |
| **按"工具/模型"拆分统计** | ✅ 采纳 | 从钩子输入或会话日志中读取模型名 |
| **Codex 钩子安装细节**：需要开启 `[features].hooks = true`，并在 `[hooks.state]` 里写入 trusted_hash，否则 Codex 会等待用户在界面上手动信任钩子 | ✅ 采纳 | 这是安装能否成功的关键，第 8 节有具体实现 |
| 常驻进程 | ❌ 不采纳 | 违背轻量原则 |
| 按行号跟踪归属，并存进 git notes（`refs/notes/ai`） | ❌ 不采纳 | 实现很重（仅归属跟踪就有 2700 多行），而且 notes 会随 `git push` 同步到远端。我们在 commit 时用行指纹匹配，结果只存在本机 |
| rebase / squash / stash 后迁移归属 | ❌ 暂不采纳 | 复杂度高，v1 只标记 amend |

## 3. 核心口径

**有效代码量 = 提交留存口径**：AI 工具每次调用前后对比文件内容，把新增的行记录为 AI 行指纹；commit 时，新增行中能匹配到指纹的计为 AI 行，其余计为人工行。AI 写入后又被人工改过的行，因指纹不匹配计为人工行。

行归一化：
1. 去掉首尾空白
2. 跳过空行，以及只含 `{ } ( ) [ ] ; ,` 的行，这类行不计入任何一方
3. 对归一化后的内容计算 `sha1`，取前 12 位十六进制作为指纹

匹配键为 `(repo_id, 文件相对路径, 指纹)`。每条指纹记录只能被消费一次，从而正确处理重复行。

"新增的行"按多重集合差计算：`added = multiset(改后行指纹) − multiset(改前行指纹)`。用多重集合而不是逐行 diff，实现简单，并且对行移动不敏感。

## 4. 采集流程

### 4.1 触发时机

| 时刻 | 触发方式 | 动作 |
|---|---|---|
| AI 工具调用前 | Claude Code / Codex 的 `PreToolUse` 钩子 | `aicode hook pre --tool <claude\|codex>`：记录基线 |
| AI 工具调用后 | Claude Code / Codex 的 `PostToolUse` 钩子 | `aicode hook post --tool <claude\|codex>`：与基线对比，把新增行的指纹写入 ledger |
| git commit 完成后 | 全局 `post-commit` hook | 启动脱离父进程的后台子进程执行 `aicode commit`，hook 本身立即返回 |

不设常驻进程和定时任务。

钩子只匹配会改动文件的工具：

| 工具 | 编辑类（路径已知） | Shell 类（路径未知） |
|---|---|---|
| Claude Code | `Write`、`Edit`、`MultiEdit`、`NotebookEdit` | `Bash` |
| Codex | —（`apply_patch` 也按 shell 类处理，这样无需解析补丁格式） | `apply_patch`、`exec_command`、`shell`、`shell_command`、`Bash`、`exec`、`multi_tool_use.parallel`（先去掉 `functions.` 前缀再匹配） |

其他工具（Read、Grep 等）直接跳过，不做任何处理。

### 4.2 编辑类工具

- **pre**：从 `tool_input.file_path` 取得目标文件，读取当前内容并计算行指纹的多重集合，存为基线；文件不存在时基线为空
- **post**：重新读取文件，与基线做多重集合差，得到新增行，写入 ledger
- **基线丢失**（例如 pre 钩子执行失败）：退回到直接取 `tool_input` 中的 `new_string` / `content` 行

### 4.3 Shell 类工具（含 Codex 的 `exec`）

- **pre**：
  1. 执行 `git status --porcelain=v1 -z --untracked-files=all`，得到已改动文件的集合
  2. 对这些文件执行 `lstat`，记录 `(mtime, size)`
  3. 对这些文件计算行指纹的多重集合，存为基线；超过 1MB 的文件跳过
- **post**：
  1. 再执行一次 `git status`
  2. 找出"新出现的改动文件"和"`(mtime, size)` 发生变化的文件"
  3. 对这些文件取基线：pre 时已是改动状态的，用 pre 存下的指纹；否则用 `git show HEAD:<path>` 的内容，新文件的基线为空
  4. 与当前内容做多重集合差，得到新增行，写入 ledger
- 已知误差：工具执行期间人工或其他会话对同一仓库的改动，会被算作 AI 改动（git-ai 也有同样的局限）

### 4.4 基线的临时存储

基线存放在 `~/.aicode/pending/<agent>_<session_id>_<tool_use_id>.json`。post 读取后把它改名为 `.done` 标记，而不是直接删除；超过 1 小时的 pending 和 `.done` 文件在下次执行时清理。

**重复触发去重**：全局模式和项目模式同时安装时，同一次工具调用会触发两遍钩子。
- pre：pending 或 `.done` 已存在时跳过
- post：`.done` 已存在时跳过。这样第二次 post 不会因为取不到基线，而退回去用工具参数重复记录

### 4.5 预算与上限

- 单个钩子最长执行 2 秒，超时后放弃本次采集并以退出码 0 退出
- `git status` 结果超过 5 万个文件时跳过 shell 快照
- 单个文件超过 1MB 时不计算指纹
- 忽略规则（见 6.2）命中的文件不采集

### 4.6 模型识别

- Codex：优先取钩子输入中的 `model`；没有时从会话日志末尾最多 256KB 中，找到最近一条 `turn_context.payload.model`（已在 codex-cli 0.155.1/0.157.1 实测：`session_meta` 中不含模型名，且每轮对话都可能更换模型）
- Claude Code：从 `transcript_path` 文件末尾最多 64KB 中，找到最近一条 assistant 消息的 `message.model`
- 识别失败时记为 `unknown`

## 5. 存储（整机全局）

```
~/.aicode/
├── config.json             # 全局配置
├── ledger/<repo_key>.jsonl # 待匹配的 AI 行指纹，按仓库分文件
├── pending/                # pre/post 之间的基线临时文件
├── events.jsonl            # 全机所有项目的 commit 统计事件
├── events.reported.jsonl   # 已上报事件的 event_id
├── git-hooks/              # 全局 hooksPath 目录
└── logs/aicode.log
```

- `repo_id`：取 origin remote 的 `host/group/project`；没有 remote 时为 `local:<仓库根目录绝对路径>`。`repo_key` 取 `repo_id` 的 sha1 前 16 位，用作文件名
- ledger 每行一条记录：`{"p":"src/login.ts","f":"a1b2c3d4e5f6","t":"claude-code","m":"claude-opus-5-5","s":"<session>","ts":1727143200,"c":"<消费该记录的 commit sha，可选>"}`。`c` 标记该记录已被哪次 commit 消费；amend 产生新 commit 时，旧 commit（`HEAD@{1}`）名下的记录会被临时借回参与匹配，重新匹配上则把 `c` 改为新 commit 的 sha，没匹配上则清空 `c` 放回未消费状态（见 §6.1）
- 并发控制：`hook post` 追加写入和 `commit` 改写 ledger，都要先获取 `ledger/<repo_key>.lock`（用 `O_EXCL` 创建，超过 10 秒视为陈旧锁并接管）。`commit` 是先写临时文件再 rename 替换，如果追加写入不加锁，期间追加的记录会丢失
- 清理：`commit` 改写 ledger 时，丢弃超过 7 天的记录，不论是否已被消费（`c` 不影响 TTL）

## 6. commit 统计

### 6.1 CommitEvent（追加写入 `events.jsonl`）

```json
{
  "event_id": "<repo_id>:<commit_sha>",
  "repo": "gitlab.example.com/group/project",
  "branch": "feature/login-v2",
  "commit_sha": "...",
  "parent_sha": "...",
  "commit_message": "feat: 登录改版",
  "committed_at": "2026-09-24T10:00:00+08:00",
  "amend": false,
  "owner": { "name": "...", "email": "..." },
  "module": "user-center",
  "stats": {
    "added_total": 120,
    "added_ai": 85,
    "added_human": 35,
    "deleted_total": 20,
    "ai_ratio": 0.708,
    "ai_generated": 110,
    "ai_accept_rate": 0.773,
    "by_tool": {
      "claude-code/claude-opus-5-5": { "ai": 70, "generated": 90 },
      "codex/gpt-5.6-luna": { "ai": 15, "generated": 20 }
    }
  },
  "files": [
    { "path": "src/login.ts", "module": "user-center", "added": 50, "ai": 40 }
  ],
  "client_version": "0.1.0"
}
```

- `added_total` 只统计归一化后的有效行、且未被忽略规则命中的文件，等于 `added_ai + added_human`
- `ai_generated`：统计开始时，ledger 中属于本次 commit 所涉及文件的记录总数；`ai_accept_rate = added_ai / ai_generated`。这是近似值：同一文件的 AI 改动如果分多次提交，未提交的部分也会被计入分母
- `amend`：reflog 最新一条的信息以 `commit (amend)` 开头时为 true，由消费方决定是否去重。此时旧 commit（`HEAD@{1}`）名下已消费的 ledger 记录会被临时借回参与本次匹配，从而保留原有 AI 行的归属（不会因为 amend 而误判为人工新增）：重新匹配上的记录改记为新 commit 的 sha，没匹配上的清空归属、放回未消费状态
- merge commit（有多个父提交）直接跳过
- 去重："该 commit 是否已统计"的检查放在 ledger 锁内进行。两种安装模式同时触发两次 `aicode commit` 时，只会生成一条事件
- 二进制文件忽略；重命名的文件按新路径匹配
- `owner`：优先取配置中的 `owner`，否则取 git 的 `user.name` / `user.email`
- `module`：按配置中的 `modules` glob 映射逐个文件匹配，第一个命中的规则生效；都未命中时，分支名为 `feature/xxx` 或 `hotfix/xxx` 的取 `xxx`，否则为 `unknown`。commit 级的 `module` 取新增行最多的那个模块

### 6.2 忽略规则

内置默认规则（参考 git-ai），可在配置 `ignore` 中追加：

```
*.lock  package-lock.json  yarn.lock  pnpm-lock.yaml  go.sum  Gemfile.lock  poetry.lock
composer.lock  Pipfile.lock  shrinkwrap.yaml  *.generated.*  *.min.js  *.min.css  *.map
**/vendor/**  **/node_modules/**  **/__snapshots__/**  **/*.snap
*.pb.go  *.pb.h  *.pb.cc  *_pb2.py  *_pb2_grpc.py  *.pb.swift  *.pb.dart
```

此外，仓库根目录 `.gitattributes` 中标记为 `linguist-generated` 的路径也一并忽略。

## 7. 配置

全局配置 `~/.aicode/config.json`。仓库根目录下的 `.aicode.json` 只能覆盖 `owner`、`modules`、`ignore` 三个字段；**`reporter` 只从全局配置读取**，防止 clone 下来的恶意仓库借此执行任意代码：

```json
{
  "owner": { "name": "张三", "email": "zhangsan@example.com" },
  "modules": [
    { "path": "src/user/**", "name": "user-center" },
    { "path": "src/order/**", "name": "order" }
  ],
  "ignore": ["docs/generated/**"],
  "reporter": { "type": "noop", "module": "/path/to/my-reporter.js", "options": {} }
}
```

- `reporter.type` 可选 `noop`、`module` 或 `mysql`；`module` 只在 `type` 为 `module` 时生效，`options` 原样传给对应的 Reporter
- 全局配置文件可能包含数据库密码，`init` 会把它的权限设为 600
- glob 只支持 `**`、`*`、`?`，由内置的小函数转换为正则；不含 `/` 的模式匹配任意层级下的文件名

## 8. Reporter 扩展接口

```ts
export interface Reporter {
  name: string;
  report(event: CommitEvent): Promise<void>;
}
// 自定义模块：export default (options: Record<string, unknown>) => Reporter
```

- 默认使用 `NoopReporter`，`report` 直接返回
- `report` 成功后，把 `event_id` 追加到 `events.reported.jsonl`；失败时只写日志。每次执行 `aicode commit` 时，补发未上报的事件，每次最多 50 条
- 以后接入 HTTP 网关：新增 `HttpReporter` 并注册为 `type: http`，其他代码不用改

### 8.1 MySQL 上报（`type: "mysql"`）

开发机直接连接团队 MySQL 写入统计数据。

**配置**：
```json
"reporter": {
  "type": "mysql",
  "options": { "host": "db.example.com", "port": 3306, "user": "aicode_writer", "database": "ai_stats", "password": "可选" }
}
```
密码优先读取环境变量 `AICODE_MYSQL_PASSWORD`，没有时读取 `options.password`。

**安全**：
- DBA 创建**只有 INSERT 权限**的专用账号，账号即使泄露也无法读取、修改或删除数据
- 客户端不建表；建表脚本 `sql/schema.sql` 由 DBA 执行

**兼容 MySQL 5.6**：
- 不使用 JSON 列：按工具拆分的统计单独存一张表 `ai_commit_tool`
- 5.6 默认单列索引上限为 767 字节，所以主键使用 ASCII 哈希列：`repo_key`（repo 的 sha1 前 16 位）、`path_sha1`；邮箱索引使用 191 字符前缀
- 字符集为 `utf8mb4`，时间统一存 UTC 的 `DATETIME`

**表结构**：

| 表 | 主键 | 内容 |
|---|---|---|
| `ai_commit` | `(repo_key, commit_sha)` | 仓库、分支、负责人、模块、各项行数、AI 占比、采纳率、提交时间；索引：仓库+时间、负责人+时间、模块+时间 |
| `ai_commit_file` | `(repo_key, commit_sha, path_sha1)` | 文件路径、模块、新增行数、AI 行数 |
| `ai_commit_tool` | `(repo_key, commit_sha, tool, model)` | 按工具/模型统计的 AI 行数和生成行数 |

**写入**：
- 同一事件的三张表在一个事务中写入；全部使用 `INSERT IGNORE`，重复上报幂等，也不需要 UPDATE 权限
- 一次补发共用一个连接，结束时关闭（`Reporter` 接口增加可选的 `close()`）；连接超时 5 秒
- 写入失败则回滚并抛出异常，事件留在本地，下次 commit 时补发
- `mysql2` 只在 `type` 为 `mysql` 时动态加载

## 9. 安装：`aicode init`

支持两种安装模式，统计数据都写入 `~/.aicode/`，统一汇总。

| | 全局模式 `aicode init` | 项目模式 `aicode init --local`（在仓库内执行） |
|---|---|---|
| 覆盖范围 | 本机所有仓库 | 当前仓库 |
| Claude Code | `~/.claude/settings.json` | `<仓库>/.claude/settings.local.json` |
| Codex | `~/.codex/config.toml` | 钩子定义写入 `<仓库>/.codex/config.toml`；**信任记录必须写入全局 `~/.codex/config.toml`**（见 9.3）。Codex 只为已信任的项目加载项目配置；项目未被信任时提示并跳过 Codex，不修改项目信任级别 |
| git | 全局 `core.hooksPath` + 转发脚本 | `<git-common-dir>/hooks/post-commit` |

### 9.1 共同规则

1. **写入前确认**：先列出将要改动的每个文件及改动摘要，用户输入 `y` 才写入。`--yes` 可跳过确认；非交互环境（stdin 不是 TTY）下没有 `--yes` 时，直接中止并提示
2. **先备份**：已存在的文件在首次修改前备份为 `<文件>.aicode.bak`
3. **可逆**：`aicode init --uninstall`（全局）和 `aicode init --local --uninstall`（项目）只移除 aicode 写入的内容，其余内容原样保留
4. 创建 `~/.aicode/` 目录结构和默认 `config.json`（两种模式都会做）
5. 所有钩子命令都使用 node 和 CLI 的绝对路径，避免钩子运行环境中 PATH 找不到 node（如使用 nvm）

### 9.2 Claude Code 钩子

在 settings 文件的 `hooks.PreToolUse` 和 `hooks.PostToolUse` 中各合并一条配置：`matcher` 为 `Write|Edit|MultiEdit|NotebookEdit|Bash`，命令分别为 `aicode hook pre --tool claude` 和 `aicode hook post --tool claude`。重复安装时先移除旧的 aicode 条目再写入，保证幂等。

### 9.3 Codex 钩子

修改对应的 `config.toml`：
- 设置 `[features].hooks = true`：已为 true 时不改动；原值为 false 时改为 true，并加上 `# aicode` 标记，卸载时删除该行
- 在 `[hooks]` 的 `PreToolUse` 和 `PostToolUse` 下各追加一个不带 matcher 的 command 钩子，由 aicode 自己按工具名过滤
- 写入信任记录 `[hooks.state."<key>"]`，否则 Codex 会等用户在界面上手动信任：
  - key：`"<config.toml 绝对路径>:<pre_tool_use|post_tool_use>:<分组下标>:<钩子下标>"`
  - value：`{ enabled = true, trusted_hash = "<hash>" }`
  - hash：`sha256(规范化 JSON {event_name, hooks:[{type:"command", async:false, command, timeout:600}]})`，规范化指按 key 排序
- aicode 写入的内容集中在 `# >>> aicode hooks >>>` 和 `# <<< aicode hooks <<<` 两个标记之间，便于卸载
- TOML 只做最小范围的文本追加和替换，不引入 TOML 库
- **项目模式的信任记录位置（已在 codex-cli 0.157.1 真机验证）**：Codex 不接受写在仓库自身 `.codex/config.toml` 中的信任记录（否则仓库可以给自己的钩子"盖章"），钩子会被静默跳过。正确写法是：
  - 钩子定义（含 `[features].hooks = true`）写在 `<仓库>/.codex/config.toml`，不写 `hooks.state`
  - 信任记录写在全局 `~/.codex/config.toml`，key 仍为项目配置文件的绝对路径：`"<仓库>/.codex/config.toml:<pre_tool_use|post_tool_use>:<分组下标>:0"`
  - 每个项目的信任记录用 `# >>> aicode trust <项目配置路径> >>>` 和 `# <<< aicode trust <项目配置路径> <<<` 包住，项目模式卸载时只删除该项目的区块
  - 项目模式不修改全局的 `[features]`，依赖 hooks 特性默认开启（`codex features list` 显示 hooks 为 stable/true）
- 因此项目模式安装 Codex 时**会改动全局 `~/.codex/config.toml`**（仅追加该项目的信任区块），`init` 的确认清单中要明确列出

### 9.4 git hook

**全局模式**：
- 设置 `git config --global core.hooksPath ~/.aicode/git-hooks`。如果原来已设置全局 hooksPath，先记录到 `~/.aicode/install-state.json`
- 在该目录下为所有标准 hook 生成转发脚本：原来有全局 hooksPath 时调用其中的同名 hook，否则调用仓库自己的 `.git/hooks/<name>`，并保留其退出码
- `post-commit` 在转发之后，额外在后台启动 `aicode commit`

**项目模式**：
- 如果 `<git-common-dir>/hooks/post-commit` 已存在且不是 aicode 生成的，先改名为 `post-commit.aicode-orig`
- 写入新的 `post-commit`：先调用 `post-commit.aicode-orig`（如有）并保留其退出码，再在后台启动 `aicode commit`
- 卸载时删除 aicode 的 `post-commit`，并把 `.aicode-orig` 改回原名

### 9.5 项目模式不污染仓库

- 新建的 `.claude/settings.local.json` 和 `.codex/config.toml` 追加到 `<git-common-dir>/info/exclude`，卸载时移除这两行
- 如果上述文件已被 git 跟踪（例如团队共享的配置），则**不修改**，并提示用户改用全局模式或手动配置

### 9.6 已知限制

- 仓库级配置了 `core.hooksPath` 的仓库（例如使用 husky v5 及以上版本）：全局模式的 hooksPath 会被覆盖，项目模式写入的 `.git/hooks` 也不会被调用，`post-commit` 统计都不会触发。v1 接受这一限制，`init` 检测到这种情况时给出提示
- 项目模式下，如果该项目未被 Codex 信任，就只采集 Claude Code 的数据

## 10. 错误处理

所有 `aicode` 子命令的异常都只写入 `~/.aicode/logs/aicode.log`，进程一律以退出码 0 退出，**绝不阻塞** AI 工具或 git。唯一例外是转发脚本透传仓库原有 hook 的退出码，以保证 `pre-commit` 等原有检查仍然生效。

## 11. 代码结构

```
src/
  cli.ts                 # 子命令分发：init / hook pre|post / commit
  fingerprint.ts         # 行归一化、哈希、多重集合差
  git.ts                 # 仓库根目录、repo_id、分支、status、diff 解析
  ignore.ts              # 默认忽略规则、linguist-generated、glob 转正则
  snapshot.ts            # pre/post 基线：编辑类与 shell 类
  ledger.ts              # 追加写入、加锁、消费、清理
  analyzer.ts            # diff × ledger → 统计
  metadata.ts            # owner / module
  config.ts              # 读取并合并 JSON 配置
  reporter/index.ts      # 接口、注册表、noop、module/mysql 加载
  reporter/mysql.ts      # MySQL 直连上报（动态加载 mysql2）
sql/schema.sql           # MySQL 5.6+ 建表脚本
  agents/claude.ts       # 解析钩子输入、工具分类、模型识别
  agents/codex.ts
  installer/claude.ts
  installer/codex.ts     # 含 trusted_hash 计算
  installer/git.ts
```

## 12. 测试

- 单元测试（vitest，仅作为开发依赖）：fingerprint 与多重集合差、diff 解析、ignore 匹配、ledger 消费计数与加锁、module 映射、config 合并、reporter 加载、Codex trusted_hash 计算
- 钩子测试：以 Claude Code / Codex 的 Pre/Post 钩子 stdin 样本为 fixture，覆盖编辑类、shell 类、基线丢失、超时等场景
- 集成测试：用临时 HOME 和临时 git 仓库，执行 `init` → 模拟 pre/post（含一次 shell 写文件）→ 人工修改部分行 → 真实 `git commit` → 断言 `events.jsonl` 中的 AI 行数、人工行数和 `ai_generated`，并验证仓库原有 hook 仍被调用
- MySQL：单元测试注入假连接，校验 SQL、参数、事务和回滚；设置 `AICODE_TEST_MYSQL_URL` 时对真实 MySQL 跑集成测试（验证重复上报幂等）
- 真机验证：在本机 Claude Code 和 Codex（0.155.1）上各完成一次"AI 修改 → 提交"，核对统计结果
- 性能：编辑类钩子 < 50ms；shell 类钩子在 1 万个文件的仓库中 < 300ms；包含 1000 行改动的 commit，统计耗时 < 1s

## 13. 补充需求（2026-09-29）

### 13.1 统计名单（全局安装下控制统计范围）

- 全局配置新增 `"track": { "mode": "all" | "list", "repos": ["<repo_id>", ...] }`；缺省为 `{ "mode": "all", "repos": [] }`（即原行为）
- `mode = "list"` 时，只有 `repo_id` 在 `repos` 中的仓库才会被统计：钩子在 pre 阶段直接跳过（不存基线、不写 ledger），`aicode commit` 直接返回，不生成事件
- `track` 只从全局配置读取，仓库级 `.aicode.json` 不能修改
- 命令（在仓库内执行）：
  - `aicode track`：把当前仓库加入名单，并把 `mode` 设为 `list`（首次切换时提示"现在只统计名单中的仓库"）
  - `aicode untrack`：把当前仓库移出名单
  - `aicode track --all`：`mode` 改回 `all`（名单保留）
  - `aicode track --list`：打印当前模式与名单
- `aicode init --local` 安装时把当前仓库加入名单（不改变 `mode`），`--local --uninstall` 时移出
- 写入全局配置时保留其中的未知字段，文件权限保持 600

### 13.2 MySQL 配置向导

- `aicode config mysql`：交互式依次询问 host、port（默认 3306）、database、user、password（输入不回显）；已有配置时以现值作为默认值，直接回车沿用（密码回车表示沿用原密码）
- 保存前测试：连接超时 5 秒；执行 `SELECT 1`；执行 `SHOW GRANTS FOR CURRENT_USER()`，确认对该库（`db.*`、`db.ai_commit` 等三张表，或 `*.*` / `ALL PRIVILEGES`）具有 INSERT 权限
- 测试失败时显示原因并询问"仍然保存？[y/N]"
- 保存到全局配置 `reporter = { type: "mysql", options: { host, port, user, password, database } }`，文件权限 600
- `aicode config mysql --disable`：把 `reporter` 改为 `{ type: "noop" }`
- 必须在交互终端中运行；非交互环境直接报错退出（退出码 1）
- 输出与日志中不得出现密码

### 13.3 同步与状态

- 本地队列即 `events.jsonl` + `events.reported.jsonl`（第 8 节），不变
- `aicode sync`：循环分批（每批 50 条）上报全部未上报事件，直到队列为空或遇到失败；忽略退避，总是立即尝试；打印成功条数、剩余条数与失败原因；退出码：全部成功 0，否则 1
- 提交时的自动补发（`aicode commit` 末尾）改为受退避控制：
  - 同步状态存于 `~/.aicode/sync-state.json`：`{ lastAttemptAt, lastSuccessAt, lastError, consecutiveFailures, nextRetryAt }`
  - 失败后 `consecutiveFailures += 1`，`nextRetryAt = now + min(2^(consecutiveFailures-1) 分钟, 30 分钟)`；成功后清零
  - 自动补发仅在 `now >= nextRetryAt` 时进行；手动 `aicode sync` 同样更新该状态
  - `reporter.type = "noop"` 时视为总是成功
- `aicode status`：打印统计模式与名单、reporter 类型（mysql 时显示 host/database/user，不显示密码）、队列积压条数、最近一次同步时间与结果、下一次允许自动补发的时间
- 不做定时同步

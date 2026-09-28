# Codex 钩子真机探针记录（2026-09-28）

## 环境

- codex-cli 版本：`0.157.1`（任务简报假设的是 0.155.1，实际机器上安装的是 0.157.1，二者在 `codex exec` 的 CLI 参数上不兼容，见下）
- Node：v20.11.0
- 探针脚本：`scripts/probe-codex-hooks.mjs`（按简报逐字编写，仅对一处 CLI 参数做了必要的版本兼容修正，见"脚本偏差"）

## 脚本偏差（在正式发起真实请求之前发现，未消耗"真实请求"次数）

简报脚本使用 `codex exec --full-auto ...`。在安装的 0.157.1 版本上，`codex exec` 不再接受 `--full-auto`（`codex exec --help` 未列出该参数，报 `error: unexpected argument '--full-auto' found`，退出码 2，命令在联系 API 之前就失败，两个场景均未产生任何钩子调用）。

已确认 `codex exec --help` 中沙箱相关的替代参数为 `-s, --sandbox <read-only|workspace-write|danger-full-access>`。将脚本中的：

```js
['exec', '--full-auto', '--skip-git-repo-check', '-C', repo, ...]
```

改为：

```js
['exec', '-s', 'workspace-write', '--skip-git-repo-check', '-C', repo, ...]
```

其余脚本内容与简报完全一致，未做其他修改。这次参数修正后的运行是唯一一次成功发起真实请求的运行（未再重试）。

## Step 2 运行输出（完整，已按规则 2 检查——未发现 token/secret 内容，字段名与 tool_name 均可公开）

```
===== 场景 global =====
codex exit: 0
repo files: [ '.git', 'a.txt', 'b.txt' ]
hook calls: 6
pre Bash session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_use_id
post Bash session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_response,tool_use_id
pre apply_patch session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_use_id
post apply_patch session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_response,tool_use_id
pre Bash session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_use_id
post Bash session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_response,tool_use_id
first payload: {"session_id":"01a0e72f-...","turn_id":"01a0e72f-...","transcript_path":"<tmp>/codex-probe-global-IUS4Jp/codex-home/sessions/2026/09/28/rollout-....jsonl","cwd":"<tmp>/codex-probe-global-IUS4Jp/repo","hook_event_name":"PreToolUse","model":"gpt-5.6-luna","permission_mode":"bypassPermissions","tool_name":"Bash","tool_input":{"command":"sed -n '1,240p' /Users/yangxiaoyue/.agents/skills/superpowers/using-superpowers/SKILL.md"},"tool_use_id":"exec-7c2e01b0-..."}
workdir: <tmp>/codex-probe-global-IUS4Jp

===== 场景 project =====
codex exit: 0
repo files: [ '.codex', '.git', 'a.txt', 'b.txt' ]
hook calls: 0
first payload: undefined
workdir: <tmp>/codex-probe-project-Gzsm4s
```

（`session_id`/`turn_id`/`tool_use_id` 的具体值、临时目录随机后缀已省略/截断，不影响结论；日志文件本身在写入本笔记后已按 Step 4 删除。）

说明：global 场景第一条 pre-hook 的 `tool_input.command` 是模型自行读取了本机 `~/.agents/skills/...` 下的一个 superpowers skill 文件，这是当前真实开发环境自带的行为（与本探针的 prompt 无关），不涉及任何 token/secret，仅作为观察记录在此。

## 逐场景关键事实

- **global**：`hook calls = 6`（pre/post × Bash × 2 次 + pre/post × apply_patch × 1 次），退出码 0，stderr 未出现 trust/review 字样，`a.txt`、`b.txt` 均生成。
- **project**：退出码 0，`a.txt`、`b.txt` 均生成（说明 Codex 正常执行了 apply_patch 和 shell 操作），但 **`hook calls = 0`**，对应的日志文件全程未生成（钩子从未被调用），stderr 中也没有 trust/review 报错。
- 项目场景的信任声明写在全局 `config.toml` 的 `[projects."<repo 绝对路径>"]` 段（`trust_level = "trusted"`），钩子定义与 `trusted_hash` 均写在项目 `.codex/config.toml` 中，key 为 `"<项目配置文件绝对路径>:pre_tool_use:0:0"` / `...:post_tool_use:0:0"`，与简报的写法完全一致。

## 按决策表逐条结论

| 观察结果 | 是否命中 | 结论 |
|---|---|---|
| global 场景 `hook calls` ≥ 4，且没有 trust/review 提示 | **是**（=6） | 全局 `trusted_hash` 算法正确，Task 13 可按计划实现全局模式 |
| global 场景 `hook calls` 为 0，stderr 出现 trust/review 字样 | 否 | 不适用 |
| 两个场景的 `hook calls` 都为 0，且没有任何提示 | 否（global 场景为 6） | 不适用 |
| **global 正常，project 场景的 `hook calls` 为 0** | **是** | **项目级信任记录的写法不对（可能需要写进全局文件，或 key 路径不同）。按控制器规则：停止执行，不再自行调试 Codex 行为，把发现报告给用户，由用户决定：先只支持全局模式的 Codex，还是继续研究项目级钩子的正确写法** |
| 日志文件没有生成，但 stderr 有权限错误 | 否（global 场景日志正常生成在 `$HOME` 下，说明钩子未受沙箱限制无法写 `$HOME`；project 场景日志未生成是因为钩子从未被调用，不是权限错误） | 不适用；额外结论：钩子进程可以正常写入 `$HOME`（未观察到沙箱权限拒绝） |
| 观察到的 `tool_name` 集合 | 观察到 `Bash`、`apply_patch` 两种 | 均已在预期范围内（Task 7 `classifyCodexTool` 覆盖的改文件工具应包含 `apply_patch` 与 `Bash`/shell 类命令），未发现列表之外的新工具名 |
| stdin 中是否有 `tool_use_id`、`transcript_path`、`model` | 三者均存在 | Task 8 的"重复触发去重"逻辑可以正常依赖 `tool_use_id`，无需降级为"以最后一次 pre 为准" |

## 本次探针未解决、需要用户决策的问题

**项目级钩子（写在项目 `.codex/config.toml` 中的钩子 + 信任记录）在真机上未被触发**，即使：
- 全局 `config.toml` 中已通过 `[projects."<repo>"]` `trust_level = "trusted"` 声明该项目为受信任；
- 项目 `.codex/config.toml` 中同时包含 `[features] hooks = true`、钩子定义、以及 key 为项目配置文件绝对路径的 `trusted_hash` 信任记录（写法与全局场景完全对称）。

Codex 仍然正常执行了 apply_patch 与 shell 操作（说明项目信任本身被识别、不是"未信任"导致的整体失败），但钩子从未被调用，也没有任何 trust/review 类报错输出。

根据控制器规则，本任务到此为止，**不再尝试修复或进一步调试 Codex 的项目级钩子行为**，也未运行交互式 `codex` TUI（无法驱动，留待用户后续手动验证：`CODEX_HOME=<临时 codexHome> codex -C <repo>`，输入同样的 prompt，观察交互模式下项目级钩子是否触发）。

建议后续动作（供用户选择）：
1. Task 13 先只实现并支持全局模式的 Codex 钩子，项目模式标记为暂不支持/待研究；或
2. 进一步排查项目级钩子的正确配置方式（例如是否要求钩子定义本身也写在全局文件、或信任记录的 key 路径格式不同），必要时参照 git-ai 的 `src/mdm/agents/codex.rs` 实现，但本次探针未做这一步排查。

## 变更文件

- 新增 `scripts/probe-codex-hooks.mjs`
- 新增 `docs/superpowers/notes/2026-09-24-codex-hooks-probe.md`（本文件）

## 清理

- 已运行 `rm -f ~/.aicode-probe-*.log`
- 按控制器规则 1，在写完本笔记后额外删除了探针创建的临时工作目录（含 `auth.json` 副本）：
  - 失败重试前遗留的两个目录（CLI 参数错误、未发起真实请求）：`codex-probe-global-VgFzP7`、`codex-probe-project-Obugqt`
  - 成功运行产生的两个目录：`codex-probe-global-IUS4Jp`、`codex-probe-project-Gzsm4s`
- 未修改 `~/.codex/config.toml`、`~/.claude`、全局 git 配置。

## 安全说明

本笔记及运行日志中未包含任何 `auth.json` 中的 token/secret 内容；`tool_input`/`tool_response` 相关字段仅记录了字段名与本次探针命令本身（新建 `a.txt`/`b.txt`、`echo world`），未发现敏感内容需要脱敏。

---

## 追加验证（方案 B）：项目级钩子信任记录应写在哪里

用户选择方案 B：继续研究项目级 Codex 钩子为何不触发，而不是仅回退到"只支持全局模式"。

### 假设

Codex 出于安全考虑，拒绝信任"写在仓库自己的 `.codex/config.toml` 里"的信任状态（因为这等于项目自己给自己的钩子盖章，绕过了用户确认）；项目级钩子要生效，`[hooks.state."<key>"]` 必须写在全局 `CODEX_HOME/config.toml` 中，即便钩子*定义*本身仍然放在项目 `.codex/config.toml`。

### Step A：低成本证据（未发起真实请求）

1. 定位真实的 codex 原生二进制（`codex` 命令是 `@openai/codex` npm 包里的 Node 包装脚本，实际按平台转发到 `node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex`），对其跑 `strings` 并 grep 关键字：

   ```
   strings <codex 原生二进制> | grep -F "trusted_hash" | sort -u
   strings <codex 原生二进制> | grep -iE "hook.{0,40}(trust|review|approv|disab|skip|untrust)" | sort -u
   ```

2. 关键发现（均为二进制中的字符串/结构体名，不涉及任何密钥）：
   - 存在一个显式的配置来源枚举：`Admin config / User config / Project config / Session flags / Cloud-managed config / Unknown source`，说明 Codex 内部确实区分"项目配置层"和其它层，且钩子/信任在概念上是"分层"读取、合并的。
   - `codex exec --help` 中存在 `--dangerously-bypass-hook-trust`：*"Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS. Intended only for automation that already vets hook sources"*。这是一个现成的诊断开关：可以先跳过信任校验，单独验证"钩子定义有没有被加载/执行"，从而把"加载问题"和"信任匹配问题"分开，不需要盲猜 key 格式就能定位问题所在层。
   - 二进制中还有 `config/batchWrite failed while updating hook trust in TUI`，说明交互式 TUI 下信任是通过一个统一的 "config/batchWrite" 写操作持久化的，暗示信任记录的写入路径是被框架统一管理的，而不是"信任写在哪个文件都行"。
   - 另外找到了一类"某些字段必须写在非项目配置层"的报错模板（如 `` `[features].use_xaa = true` must be selected in a non-project config layer``），但列举到的具体字段属于企业级 MCP/auto-review 相关配置，字符串里没有直接看到专门针对 `hooks.state`/`trusted_hash` 的同类模板；不能由此直接证明"信任状态"被列入了同一类限制，只能作为"Codex 确实存在'部分配置项禁止写在项目层'这种设计模式"的旁证。
   - 未找到与"项目自身声明钩子已受信任"直接矛盾的报错字符串（例如没有找到 "project cannot self-trust hooks" 这类文本），说明 Codex 大概率不会对着"写反了位置"报错提示，而是静默不触发——这与本任务第一轮 project 场景"exit 0、无 trust/review 字样、hook calls=0"的现象一致。

3. 未能获取到 git-ai 源码：协调者提供的路径 `/private/tmp/claude-501/.../scratchpad/git-ai` 在本机不存在（`ls`/`find` 均未找到任何 `git-ai` 目录或 `codex.rs` 文件）。本轮验证结论完全基于对 codex 原生二进制字符串的分析，未能与 git-ai 的 `src/mdm/agents/codex.rs` 实现做交叉核对，这是一个已知局限，如实记录。

结论：现有证据不足以精确定位官方源码里的判定逻辑，但足以支持"应优先用 `--dangerously-bypass-hook-trust` 做加载/信任分离测试，再针对性验证'信任记录搬到全局文件'"这一测试顺序，避免盲目枚举 key 变体。

### Step B：真实 Codex 请求（本轮共发起 2 次，未超过预算 3 次）

#### 请求 1：`project-bypass`（诊断：项目级钩子定义是否被加载）

文件布局与第一轮 `project` 场景完全一致（钩子定义 + `[hooks.state.*]` 信任记录都写在 `<repo>/.codex/config.toml`，全局文件只声明 `[projects."<repo>"] trust_level = "trusted"`），唯一区别是调用 `codex exec` 时追加 `--dangerously-bypass-hook-trust`。

```
node scripts/probe-codex-hooks.mjs project-bypass
```

```
===== 场景 project-bypass =====
codex exit: 0
repo files: [ '.codex', '.git', 'a.txt', 'b.txt' ]
hook calls: 8
pre  Bash        session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_use_id
post Bash        session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_response,tool_use_id
pre  Bash        ...(同上，第二次 shell 调用)
post Bash        ...
pre  apply_patch session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_use_id
post apply_patch session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_response,tool_use_id
pre  Bash        ...
post Bash        ...
```

**结论：项目 `.codex/config.toml` 里的钩子定义本身是能被正常加载并执行的**（8 次调用，覆盖 `apply_patch` 和 `Bash` 两种 `tool_name`）。第一轮 `project` 场景 `hook calls = 0` 不是"钩子没被读到"，而是"钩子被读到了，但因为信任状态没通过校验，被静默跳过执行"。

#### 请求 2：`project-global-state`（验证假设：信任记录搬到全局文件）

布局：
- 项目 `<repo>/.codex/config.toml`：只放 `[features] hooks = true` + 两个 `[[hooks.PreToolUse]]`/`[[hooks.PostToolUse]]` 分组，**不含** `[hooks.state.*]`。
- 全局 `CODEX_HOME/config.toml`：`[features] hooks = true` + `[projects."<repo>"] trust_level = "trusted"` + 两个 `[hooks.state."<repo>/.codex/config.toml:pre_tool_use:0:0"]` / `...post_tool_use:0:0` 信任记录（key 路径仍然指向项目配置文件的绝对路径，`trusted_hash` 算法与第一轮完全相同）。
- 调用方式与第一轮相同，**不带** `--dangerously-bypass-hook-trust`。

```
node scripts/probe-codex-hooks.mjs project-global-state
```

```
===== 场景 project-global-state =====
codex exit: 0
repo files: [ '.codex', '.git', 'a.txt', 'b.txt' ]
hook calls: 8
pre  Bash        session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_use_id
post Bash        session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_response,tool_use_id
pre  Bash        ...
post Bash        ...
pre  apply_patch session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_use_id
post apply_patch session_id,turn_id,transcript_path,cwd,hook_event_name,model,permission_mode,tool_name,tool_input,tool_response,tool_use_id
pre  Bash        ...
post Bash        ...
```

**假设验证成功**：把 `[hooks.state.*]` 信任记录从项目 `.codex/config.toml` 搬到全局 `CODEX_HOME/config.toml`（key 路径不变，仍是项目配置文件的绝对路径），且不使用任何 bypass 开关，项目级钩子就能正常触发（8 次调用，`hook calls` ≥ 4，字段列表与全局场景一致）。因为第 2 次请求已经找到能稳定触发的写法，按控制器规则"stopping at the first one that fires hooks"，本轮验证到此结束，**未运行 S4（key 路径 realpath 变体）**，脚本中保留了 `project-global-state-realpath` 场景代码以备后续需要，但本次未执行。

### 最终结论（写入项目级钩子的正确布局）

| 内容 | 应该写在哪个文件 |
|---|---|
| `[features] hooks = true` | 全局 `CODEX_HOME/config.toml` 与项目 `<repo>/.codex/config.toml` 都需要写（两轮验证都是两处都写；未单独测试"只写一处是否够"，如需精确裁剪需另外验证） |
| `[projects."<repo 绝对路径>"] trust_level = "trusted"` | 全局 `CODEX_HOME/config.toml` |
| `[[hooks.PreToolUse]]` / `[[hooks.PostToolUse]]` 钩子定义 | 项目 `<repo>/.codex/config.toml` |
| `[hooks.state."<repo>/.codex/config.toml:pre_tool_use:0:0"]` / `...post_tool_use:0:0` 信任记录（`enabled = true` + `trusted_hash`） | **全局 `CODEX_HOME/config.toml`**（不能写在项目 `.codex/config.toml` 自身里——那样会被静默忽略，不报错、也不触发钩子） |
| key 路径格式 | 仍是"项目配置文件的绝对路径"（`<repo>/.codex/config.toml`），不需要 realpath 规整或改成别的形式（本轮验证到此即成功，未测试 realpath 变体） |

即：**Task 13 的项目模式实现应改为——项目 `.codex/config.toml` 只承载 `[features] hooks = true` 与钩子定义，而信任记录（`[hooks.state.*]`）必须和全局模式的信任记录写在同一个文件——全局 `CODEX_HOME/config.toml`，用项目配置文件的绝对路径拼 key。** 这与最初 spec 里"信任记录写在项目文件里（key 为项目配置文件的绝对路径）"的假设不同：key 仍然用项目配置文件路径，但**存放信任记录的文件应该是全局文件，而不是项目文件本身**。

### 局限 / 未验证事项

- 未能核对 git-ai 的 `src/mdm/agents/codex.rs` 实现（该源码在本机不存在），本结论纯粹基于二进制字符串分析 + 真机试验得出，建议后续如能拿到 git-ai 源码或 Codex 官方文档，再做一次交叉核对。
- 未测试"项目 `.codex/config.toml` 里不写 `[features] hooks = true`，只在全局写"是否也能生效（本轮两处都写了，没有做减法实验）。
- 未测试 key 路径的 realpath / 符号链接变体（S4），因为 S3 已经成功，按规则未继续消耗真实请求。

### 本轮清理

- 涉及的临时工作目录（含 `auth.json` 副本）：`codex-probe-project-bypass-tdy60Z`、`codex-probe-project-global-state-DrDaUB`，已在写完本节后删除。
- `~/.aicode-probe-project-bypass-*.log`、`~/.aicode-probe-project-global-state-*.log` 已删除。
- 未修改 `~/.codex/config.toml`、`~/.claude`、全局 git 配置。

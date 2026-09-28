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

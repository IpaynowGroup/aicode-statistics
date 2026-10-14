# track/untrack 完整逻辑梳理

## 📋 命令行为总览

| 命令 | 功能 | 代码位置 |
|------|------|---------|
| `aicode track --list` | 查看当前配置 | cli.ts:94-96 |
| `aicode track --all` | 切换到 all 模式 | cli.ts:98-101 |
| `aicode track` | 在当前仓库执行 track | cli.ts:103-118 |
| `aicode untrack` | 在当前仓库执行 untrack | cli.ts:121+ |

---

## 🎯 核心逻辑

### 1. 判断是否跟踪：isRepoTracked()

```typescript
// track.ts:10-17
export function isRepoTracked(root: string): boolean {
  const track = getTrack(readGlobalConfig());
  const id = repoId(root);
  
  // all 模式：repos 是黑名单，不在列表中才跟踪
  if (track.mode === 'all') return !track.repos.includes(id);
  
  // list 模式：repos 是白名单，在列表中才跟踪
  return track.repos.includes(id);
}
```

| mode | repos 含义 | 判断逻辑 |
|------|-----------|---------|
| `all` | **黑名单** | `!repos.includes(id)` |
| `list` | **白名单** | `repos.includes(id)` |

---

### 2. track 命令：trackRepo()

```typescript
// track.ts:25-43
export function trackRepo(root: string): { id: string; switched: boolean } {
  const id = repoId(root);
  let switched = false;
  
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    
    if (track.mode === 'all') {
      // all 模式：从黑名单移除
      const idx = track.repos.indexOf(id);
      if (idx !== -1) track.repos.splice(idx, 1);
      raw.track = track;
    } else {
      // list 模式：添加到白名单并切到 list
      switched = track.mode !== 'list';
      if (!track.repos.includes(id)) track.repos.push(id);
      raw.track = { mode: 'list', repos: track.repos };
    }
  });
  
  return { id, switched };
}
```

#### 行为表格

| 当前 mode | 当前 repos | 操作 | 结果 mode | 结果 repos | switched |
|-----------|-----------|------|-----------|-----------|----------|
| `all` | `[]` | track A | `all` | `[]` | `false` |
| `all` | `[A]` | track A | `all` | `[]` | `false` |
| `all` | `[A, B]` | track A | `all` | `[B]` | `false` |
| `list` | `[]` | track A | `list` | `[A]` | `false` |
| `list` | `[B]` | track A | `list` | `[A, B]` | `false` |

#### ⚠️ 问题：没有从 all 切换到 list 的场景！

**第 36-39 行的逻辑**：
```typescript
// list 模式：添加到白名单并切到 list
switched = track.mode !== 'list';
if (!track.repos.includes(id)) track.repos.push(id);
raw.track = { mode: 'list', repos: track.repos };
```

这段代码只在 `track.mode !== 'all'` 时执行（第 35 行的 else 分支），所以：
- **如果当前是 all 模式**：只会从黑名单移除，不会切换模式
- **如果当前是其他模式**：才会切换到 list 模式

**结论：`track` 命令不会自动从 all 切换到 list！**

---

### 3. untrack 命令：untrackRepo()

```typescript
// track.ts:51-73
export function untrackRepo(root: string): { id: string; removed: boolean } {
  const id = repoId(root);
  let removed = false;
  
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    
    if (track.mode === 'all') {
      // all 模式：添加到黑名单
      if (!track.repos.includes(id)) {
        track.repos.push(id);
        removed = true;
      }
    } else {
      // list 模式：从白名单移除
      const idx = track.repos.indexOf(id);
      if (idx !== -1) {
        track.repos.splice(idx, 1);
        removed = true;
      }
    }
    raw.track = track;
  });
  
  return { id, removed };
}
```

#### 行为表格

| 当前 mode | 当前 repos | 操作 | 结果 mode | 结果 repos | removed |
|-----------|-----------|------|-----------|-----------|---------|
| `all` | `[]` | untrack A | `all` | `[A]` | `true` |
| `all` | `[A]` | untrack A | `all` | `[A]` | `false` |
| `all` | `[A]` | untrack B | `all` | `[A, B]` | `true` |
| `list` | `[A, B]` | untrack A | `list` | `[B]` | `true` |
| `list` | `[A]` | untrack A | `list` | `[]` | `true` |

✅ **untrack 不会自动切换模式，符合预期**

---

## 🔄 模式切换总结

### 如何切换模式？

| 目标模式 | 命令 | 代码位置 |
|---------|------|---------|
| 切换到 `all` | `aicode track --all` | cli.ts:98-101, track.ts:97-102 |
| 切换到 `list` | ❌ **没有直接命令** | - |

### setTrackAll() 实现

```typescript
// track.ts:97-102
export function setTrackAll(): void {
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    raw.track = { mode: 'all', repos: track.repos };  // ← repos 保留！
  });
}
```

⚠️ **注意**：`setTrackAll()` 保留了 `repos` 数组！

这意味着：
```bash
# 场景：从 list 切回 all
# 初始状态：mode: "list", repos: [A, B, C]
$ aicode track --all
# 结果状态：mode: "all", repos: [A, B, C]
# 行为：repos 从白名单变成了黑名单！现在除了 A、B、C 外都跟踪
```

---

## 🎬 完整使用场景

### 场景 1：默认使用（all 模式 + 黑名单）

```bash
# 初始状态
{ "mode": "all", "repos": [] }
→ 跟踪所有仓库

# 排除 test-project
$ cd /path/to/test-project
$ aicode untrack
{ "mode": "all", "repos": ["/path/to/test-project"] }
→ 跟踪除 test-project 外的所有仓库

# 重新跟踪 test-project
$ cd /path/to/test-project
$ aicode track
{ "mode": "all", "repos": [] }
→ 跟踪所有仓库
```

### 场景 2：手动切换到 list 模式（白名单）

```bash
# 从 all 切换到 list：需要手动编辑配置文件
# 编辑 ~/.aicode/config.json：
{
  "track": { "mode": "list", "repos": [] }
}

# 添加 project-A 到白名单
$ cd /path/to/project-A
$ aicode track
{ "mode": "list", "repos": ["/path/to/project-A"] }
→ 只跟踪 project-A

# 添加 project-B 到白名单
$ cd /path/to/project-B
$ aicode track
{ "mode": "list", "repos": ["/path/to/project-A", "/path/to/project-B"] }
→ 只跟踪 project-A 和 project-B

# 从白名单移除 project-A
$ cd /path/to/project-A
$ aicode untrack
{ "mode": "list", "repos": ["/path/to/project-B"] }
→ 只跟踪 project-B

# 切回 all 模式
$ aicode track --all
{ "mode": "all", "repos": ["/path/to/project-B"] }  # ← repos 保留！
→ 跟踪除 project-B 外的所有仓库（repos 从白名单变黑名单）
```

### 场景 3：查看当前配置

```bash
$ aicode track --list

# all 模式 + 空黑名单
当前统计所有仓库

# all 模式 + 黑名单
当前统计所有仓库，但以下仓库已加入黑名单（不跟踪）：
  - /path/to/test-project
  - /path/to/demo-project

# list 模式 + 白名单
当前只统计名单中的仓库：
  - /path/to/project-A
  - /path/to/project-B

# list 模式 + 空白名单
当前只统计名单中的仓库：
  (空)
```

---

## ⚠️ 潜在问题

### 1. 没有直接切换到 list 模式的命令

用户只能通过：
- 手动编辑配置文件
- 或先删除 `~/.aicode/config.json`，然后用 `aicode track` 添加仓库（会自动创建 list 模式）

### 2. `track --all` 保留 repos 数组

从 list 切换到 all 时，repos 从白名单变成黑名单，可能不符合用户预期。

**建议改进**：
```typescript
export function setTrackAll(): void {
  updateGlobalConfig((raw) => {
    raw.track = { mode: 'all', repos: [] };  // ← 清空 repos
  });
}
```

### 3. CLI 提示信息可能误导

```typescript
// cli.ts:112-116
if (track.mode === 'all') {
  console.log(`已从黑名单移除：${id}（重新跟踪该仓库）`);
} else {
  console.log(`已加入统计名单：${id}`);
  if (switched) console.log('现在只统计名单中的仓库（aicode track --all 可恢复统计全部）');
}
```

**问题**：第 116 行的 `switched` 永远是 `false`（因为 all 模式不会切换到 list）

---

## 📊 总结

### 当前设计的核心特点

1. **默认行为**：all 模式 + 黑名单
2. **track 不会自动切换模式**：
   - all 模式下：从黑名单移除
   - list 模式下：添加到白名单
3. **切换模式的方式**：
   - 切换到 all：`aicode track --all`
   - 切换到 list：❌ 没有命令，需要手动编辑配置
4. **repos 数组语义**：
   - all 模式：黑名单
   - list 模式：白名单

### 推荐改进

1. 添加 `aicode track --mode list` 命令切换到 list 模式
2. `setTrackAll()` 清空 repos 数组，避免语义混淆
3. 修复 CLI 提示信息中的 `switched` 逻辑

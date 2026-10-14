# track/untrack 使用说明

## 核心设计

### 两种模式

| 模式 | repos 数组含义 | 判断逻辑 |
|------|---------------|---------|
| `all` | **黑名单** - 不跟踪的仓库列表 | `!repos.includes(id)` |
| `list` | **白名单** - 只跟踪的仓库列表 | `repos.includes(id)` |

### 默认行为

初始状态：`{ mode: "all", repos: [] }`
- 跟踪所有仓库

---

## 使用场景

### 场景 1：默认跟踪所有，排除某些项目

```bash
# 初始状态：mode: "all", repos: []
# 跟踪所有仓库

# 在项目 A 中执行
$ cd /path/to/project-A
$ aicode untrack
# 已添加到黑名单：project-A（不再跟踪该仓库）

# 配置变为：mode: "all", repos: ["project-A"]
# 跟踪除 project-A 外的所有仓库 ✅

# 继续排除项目 B
$ cd /path/to/project-B
$ aicode untrack
# 已添加到黑名单：project-B（不再跟踪该仓库）

# 配置变为：mode: "all", repos: ["project-A", "project-B"]
# 跟踪除 A、B 外的所有仓库 ✅

# 重新跟踪项目 A
$ cd /path/to/project-A
$ aicode track
# 已从黑名单移除：project-A（重新跟踪该仓库）

# 配置变为：mode: "all", repos: ["project-B"]
# 跟踪除 B 外的所有仓库 ✅
```

---

### 场景 2：只跟踪特定项目（白名单）

```bash
# 初始状态：mode: "all", repos: []

# 在项目 A 中执行 track
$ cd /path/to/project-A
$ aicode track
# 已加入统计名单：project-A
# 现在只统计名单中的仓库（aicode track --all 可恢复统计全部）

# 配置变为：mode: "list", repos: ["project-A"]
# 只跟踪 project-A ✅

# 添加项目 B 到白名单
$ cd /path/to/project-B
$ aicode track
# 已加入统计名单：project-B

# 配置变为：mode: "list", repos: ["project-A", "project-B"]
# 只跟踪 A 和 B ✅

# 从白名单移除项目 A
$ cd /path/to/project-A
$ aicode untrack
# 已移出统计名单：project-A

# 配置变为：mode: "list", repos: ["project-B"]
# 只跟踪 B ✅
```

---

### 场景 3：查看当前配置

```bash
# all 模式，无黑名单
$ aicode track --list
当前统计所有仓库

# all 模式，有黑名单
$ aicode track --list
当前统计所有仓库，但以下仓库已加入黑名单（不跟踪）：
  - project-A
  - project-B

# list 模式
$ aicode track --list
当前只统计名单中的仓库：
  - project-C
  - project-D

# list 模式，空白名单
$ aicode track --list
当前只统计名单中的仓库：
  (空)
```

---

### 场景 4：恢复统计所有

```bash
# 从 list 模式切回 all 模式
$ aicode track --all
已恢复统计所有仓库

# 配置变为：mode: "all", repos: [保留原 list]
# 注意：原白名单会被保留为黑名单！
# 如果不想保留，需要手动编辑配置
```

---

## 命令总结

| 命令 | all 模式行为 | list 模式行为 |
|------|-------------|--------------|
| `aicode track` | 从黑名单移除当前项目 | 添加当前项目到白名单 |
| `aicode untrack` | 添加当前项目到黑名单 | 从白名单移除当前项目 |
| `aicode track --all` | 保持 all 模式 | 切换到 all 模式 |
| `aicode track --list` | 显示黑名单 | 显示白名单 |

---

## 实现原理

### 核心判断逻辑

```typescript
export function isRepoTracked(root: string): boolean {
  const track = getTrack(readGlobalConfig());
  const id = repoId(root);
  
  // all 模式：repos 是黑名单，不在列表中才跟踪
  if (track.mode === 'all') return !track.repos.includes(id);
  
  // list 模式：repos 是白名单，在列表中才跟踪
  return track.repos.includes(id);
}
```

### track 命令逻辑

```typescript
export function trackRepo(root: string) {
  if (track.mode === 'all') {
    // all 模式：从黑名单移除
    track.repos.splice(idx, 1);
  } else {
    // list 模式：添加到白名单并切换模式
    track.repos.push(id);
    track.mode = 'list';
  }
}
```

### untrack 命令逻辑

```typescript
export function untrackRepo(root: string) {
  if (track.mode === 'all') {
    // all 模式：添加到黑名单
    track.repos.push(id);
  } else {
    // list 模式：从白名单移除
    track.repos.splice(idx, 1);
  }
}
```

---

## 配置文件示例

### 默认配置（跟踪所有）
```json
{
  "track": {
    "mode": "all",
    "repos": []
  }
}
```

### 黑名单模式（排除某些项目）
```json
{
  "track": {
    "mode": "all",
    "repos": [
      "/Users/you/projects/project-A",
      "/Users/you/projects/project-B"
    ]
  }
}
```
**含义**：跟踪除 A、B 外的所有仓库

### 白名单模式（只跟踪特定项目）
```json
{
  "track": {
    "mode": "list",
    "repos": [
      "/Users/you/projects/project-C",
      "/Users/you/projects/project-D"
    ]
  }
}
```
**含义**：只跟踪 C 和 D

---

## 设计优势

✅ **最小改动**：只修改 `isRepoTracked` 的判断逻辑
✅ **符合直觉**：默认跟踪所有，untrack 排除特定项目
✅ **灵活性**：支持黑名单和白名单两种模式
✅ **向后兼容**：原有的 list 模式逻辑保持不变

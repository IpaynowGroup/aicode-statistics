# track/untrack 功能修复总结

## 🎯 问题描述

**原始问题**：在 `mode: "all"` 时执行 `aicode untrack`，无法停止跟踪当前项目

**根本原因**：
- `mode: "all"` 时，`repos` 数组没有实际作用
- `isRepoTracked()` 判断逻辑：`mode === 'all' || repos.includes(id)`
- 只要 `mode === 'all'`，直接返回 `true`，后面的 `repos.includes()` 永远不会执行

---

## ✅ 解决方案

### 核心改动：repos 数组语义重新定义

| 模式 | repos 数组含义 | 判断逻辑 |
|------|---------------|---------|
| `all` | **黑名单** - 不跟踪的仓库 | `!repos.includes(id)` |
| `list` | **白名单** - 只跟踪的仓库 | `repos.includes(id)` |

---

## 📝 修改的文件

### 1. src/track.ts

#### isRepoTracked() - 核心判断逻辑
```typescript
// 修改前
return track.mode === 'all' || track.repos.includes(repoId(root));

// 修改后
if (track.mode === 'all') return !track.repos.includes(id);  // 黑名单
return track.repos.includes(id);  // 白名单
```

#### trackRepo() - track 命令
```typescript
// all 模式：从黑名单移除（重新跟踪）
if (track.mode === 'all') {
  const idx = track.repos.indexOf(id);
  if (idx !== -1) track.repos.splice(idx, 1);
}
// list 模式：添加到白名单（保持原逻辑）
```

#### untrackRepo() - untrack 命令
```typescript
// all 模式：添加到黑名单（停止跟踪）
if (track.mode === 'all') {
  if (!track.repos.includes(id)) track.repos.push(id);
}
// list 模式：从白名单移除（保持原逻辑）
```

#### describeTrack() - 状态显示
```typescript
// all 模式显示黑名单信息
if (track.mode === 'all') {
  if (track.repos.length === 0) return '当前统计所有仓库';
  return `当前统计所有仓库，但以下仓库已加入黑名单（不跟踪）：\n${list}`;
}
```

### 2. src/cli.ts

- 添加 `readGlobalConfig` 导入
- 优化 track/untrack 命令的提示信息，区分 all/list 模式

### 3. README.md

- 更新 track 命令说明
- 添加 track 配置语义说明
- 添加文档链接

---

## 📚 新增文档

### docs/track-quick-reference.md
快速参考文档，包含：
- 查看配置命令
- 常用命令表格
- 4个典型使用场景
- 配置文件示例

### docs/track-untrack-usage.md
详细使用文档，包含：
- 核心设计说明
- 4个完整使用场景
- 命令总结表格
- 实现原理代码
- 配置文件示例

---

## 🧪 测试验证

创建并执行了 7 个测试用例：
- ✅ 默认状态跟踪所有
- ✅ all 模式黑名单功能
- ✅ all 模式其他仓库仍跟踪
- ✅ all 模式多个黑名单
- ✅ list 模式空白名单
- ✅ list 模式白名单功能
- ✅ list 模式排除其他仓库

**结果：7 通过, 0 失败** ✅

---

## 🎉 使用示例

### 查看当前配置
```bash
$ aicode track --list
当前统计所有仓库
```

### 停止跟踪当前项目
```bash
$ cd /path/to/project-A
$ aicode untrack
已添加到黑名单：project-A（不再跟踪该仓库）

$ aicode track --list
当前统计所有仓库，但以下仓库已加入黑名单（不跟踪）：
  - /path/to/project-A
```

### 重新跟踪项目
```bash
$ cd /path/to/project-A
$ aicode track
已从黑名单移除：project-A（重新跟踪该仓库）

$ aicode track --list
当前统计所有仓库
```

---

## ✨ 设计优势

1. **最小改动** - 只修改判断逻辑，不改变配置结构
2. **符合直觉** - 默认跟踪所有，untrack 排除特定项目
3. **灵活性** - 支持黑名单和白名单两种模式
4. **向后兼容** - list 模式逻辑保持不变
5. **语义清晰** - all 模式下 repos 作为黑名单很容易理解

---

## 📦 构建状态

✅ TypeScript 编译通过
✅ 所有测试通过
✅ 文档已更新
✅ 功能验证完成

---

## 🔗 相关文档

- [track 快速参考](docs/track-quick-reference.md)
- [track/untrack 详细使用说明](docs/track-untrack-usage.md)
- [README.md](README.md) - 已更新

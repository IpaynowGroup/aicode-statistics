# track/untrack 最终复核

## 📋 当前实现复核

### 1. 核心逻辑（track.ts）

#### isRepoTracked() - 判断是否跟踪
```typescript
// track.ts:10-13
export function isRepoTracked(root: string): boolean {
  const track = getTrack(readGlobalConfig());
  // all 模式：repos 是黑名单
  if (track.mode === 'all') return !track.repos.includes(repoId(root));
  // list 模式：repos 是白名单
  return track.repos.includes(repoId(root));
}
```

✅ **符合要求**：all 模式 + 黑名单逻辑

---

#### trackRepo() - track 命令核心逻辑
```typescript
// track.ts:16-32
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
      // list 模式：添加到白名单（当前不使用此分支）
      switched = track.mode !== 'list';
      if (!track.repos.includes(id)) track.repos.push(id);
      raw.track = { mode: 'list', repos: track.repos };
    }
  });
  return { id, switched };
}
```

✅ **符合要求**：all 模式下从黑名单移除

⚠️ **注意**：else 分支（list 模式）在当前设计中不会使用，但代码可以保留

---

#### untrackRepo() - untrack 命令核心逻辑
```typescript
// track.ts:45-60
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
      // list 模式：从白名单移除（当前不使用此分支）
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

✅ **符合要求**：all 模式下添加到黑名单

⚠️ **注意**：else 分支（list 模式）在当前设计中不会使用，但代码可以保留

---

#### setTrackAll() - 切换到 all 模式
```typescript
// track.ts:97-102
export function setTrackAll(): void {
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    raw.track = { mode: 'all', repos: track.repos };
  });
}
```

⚠️ **建议改进**：在只保留 all 模式的设计下，这个函数应该清空 repos
```typescript
export function setTrackAll(): void {
  updateGlobalConfig((raw) => {
    raw.track = { mode: 'all', repos: [] };  // ← 清空黑名单
  });
}
```

---

### 2. CLI 命令（cli.ts）

#### track() 函数
```typescript
// cli.ts:80-119
function track(flags: string[]): number {
  // 允许的参数：--all, --list
  const allowedFlags = new Set(['--all', '--list']);
  
  // --list：查看当前配置
  if (flags.includes('--list')) {
    console.log(describeTrack());
    return 0;
  }
  
  // --all：恢复统计所有仓库
  if (flags.includes('--all')) {
    setTrackAll();
    console.log('已恢复统计所有仓库');
    return 0;
  }
  
  // 无参数：在当前仓库执行 track
  const { id, switched } = trackRepo(root);
  if (track.mode === 'all') {
    console.log(`已从黑名单移除：${id}（重新跟踪该仓库）`);
  } else {
    console.log(`已加入统计名单：${id}`);
    if (switched) console.log('现在只统计名单中的仓库（aicode track --all 可恢复统计全部）');
  }
  return 0;
}
```

#### untrack() 函数
```typescript
// cli.ts:121-142
function untrack(flags: string[]): number {
  // 不接受任何参数
  if (flags.length) {
    console.error(`未知参数: ${flags[0]}`);
    return 1;
  }
  
  const { id, removed } = untrackRepo(root);
  if (track.mode === 'all') {
    console.log(removed ? `已添加到黑名单：${id}（不再跟踪该仓库）` : `该仓库已在黑名单中`);
  } else {
    console.log(removed ? `已移出统计名单：${id}` : '该仓库不在名单中');
  }
  return 0;
}
```

---

## ✅ 复核结果

### 符合要求的部分

1. ✅ **只保留 all 模式**：代码默认使用 all 模式，黑名单逻辑正确
2. ✅ **track 移除名单**：`trackRepo()` 在 all 模式下从黑名单移除
3. ✅ **untrack 添加名单**：`untrackRepo()` 在 all 模式下添加到黑名单
4. ✅ **--list 查看配置**：`aicode track --list` 输出当前配置
5. ✅ **list 模式代码保留**：虽然不使用，但代码保留不修改

---

## 🔧 需要修改的地方

### 1. 文档更新：去掉 --all 参数说明

#### 修改 README.md

**当前说明**：
```bash
aicode track --all    # 切换到 all 模式（统计所有仓库）
aicode track --list   # 查看当前配置（黑名单/白名单）
```

**修改为**：
```bash
aicode track          # 在当前仓库：从黑名单移除（重新跟踪）
aicode track --list   # 查看当前配置（显示黑名单）
aicode untrack        # 在当前仓库：添加到黑名单（停止跟踪）
```

---

### 2. 优化 setTrackAll()（可选）

**当前实现**：
```typescript
export function setTrackAll(): void {
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    raw.track = { mode: 'all', repos: track.repos };  // ← 保留 repos
  });
}
```

**建议改进**（在只保留 all 模式的设计下）：
```typescript
export function setTrackAll(): void {
  updateGlobalConfig((raw) => {
    raw.track = { mode: 'all', repos: [] };  // ← 清空黑名单
  });
}
```

---

### 3. 简化 CLI 提示信息（可选）

**当前实现**（cli.ts:112-117）：
```typescript
if (track.mode === 'all') {
  console.log(`已从黑名单移除：${id}（重新跟踪该仓库）`);
} else {
  console.log(`已加入统计名单：${id}`);
  if (switched) console.log('现在只统计名单中的仓库（aicode track --all 可恢复统计全部）');
}
```

**简化为**（因为只使用 all 模式）：
```typescript
console.log(`已从黑名单移除：${id}（重新跟踪该仓库）`);
```

类似地，untrack 也可以简化（cli.ts:136-140）：
```typescript
console.log(removed ? `已添加到黑名单：${id}（不再跟踪该仓库）` : `该仓库已在黑名单中`);
```

---

## 📝 总结

### 当前状态
✅ **核心逻辑完全正确**：
- all 模式 + 黑名单
- track 移除、untrack 添加
- --list 查看配置

### 需要做的
1. **必须**：更新 README.md，去掉 --all 参数说明
2. **可选**：优化 setTrackAll() 清空 repos
3. **可选**：简化 CLI 提示信息（去掉 else 分支）

### 代码保留
✅ **不需要删除 list 模式代码**：按要求保留不修改

---

## 🎯 建议操作流程

1. 更新 README.md（去掉 --all 说明）
2. 运行测试验证
3. 提交代码
4. 重新 tag 发布

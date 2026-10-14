# track/untrack 快速参考

## 查看当前配置

```bash
aicode track --list
```

### 可能的输出

#### 1. all 模式，无黑名单
```
当前统计所有仓库
```

#### 2. all 模式，有黑名单
```
当前统计所有仓库，但以下仓库已加入黑名单（不跟踪）：
  - /Users/you/projects/project-A
  - /Users/you/projects/project-B
```

#### 3. list 模式，有白名单
```
当前只统计名单中的仓库：
  - /Users/you/projects/project-C
  - /Users/you/projects/project-D
```

#### 4. list 模式，空白名单
```
当前只统计名单中的仓库：
  (空)
```

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `aicode track --list` | **查看当前配置** |
| `aicode track` | 在当前仓库中执行：<br>• all 模式：从黑名单移除（重新跟踪）<br>• list 模式：添加到白名单 |
| `aicode untrack` | 在当前仓库中执行：<br>• all 模式：添加到黑名单（不跟踪）<br>• list 模式：从白名单移除 |
| `aicode track --all` | 切换到 all 模式（跟踪所有仓库） |

---

## 典型使用场景

### 场景 1：查看当前跟踪哪些仓库

```bash
$ aicode track --list
当前统计所有仓库，但以下仓库已加入黑名单（不跟踪）：
  - /Users/you/projects/test-project
  - /Users/you/projects/tmp
```

**解读**：跟踪除了 test-project 和 tmp 外的所有仓库

---

### 场景 2：停止跟踪当前项目

```bash
$ cd /path/to/my-project
$ aicode untrack
已添加到黑名单：my-project（不再跟踪该仓库）

$ aicode track --list
当前统计所有仓库，但以下仓库已加入黑名单（不跟踪）：
  - /path/to/my-project
```

---

### 场景 3：重新跟踪之前排除的项目

```bash
$ cd /path/to/my-project
$ aicode track
已从黑名单移除：my-project（重新跟踪该仓库）

$ aicode track --list
当前统计所有仓库
```

---

### 场景 4：查看白名单模式

```bash
$ aicode track --list
当前只统计名单中的仓库：
  - /Users/you/work/project-A
  - /Users/you/work/project-B
```

**解读**：只跟踪 project-A 和 project-B，其他项目不跟踪

---

## 配置文件位置

配置保存在：`~/.aicode/config.json`

### all 模式示例（黑名单）
```json
{
  "track": {
    "mode": "all",
    "repos": [
      "/Users/you/projects/test-project",
      "/Users/you/projects/tmp"
    ]
  }
}
```
**含义**：跟踪除 test-project 和 tmp 外的所有仓库

### list 模式示例（白名单）
```json
{
  "track": {
    "mode": "list",
    "repos": [
      "/Users/you/work/project-A",
      "/Users/you/work/project-B"
    ]
  }
}
```
**含义**：只跟踪 project-A 和 project-B

---

## 小贴士

1. **定期检查配置**
   ```bash
   aicode track --list
   ```

2. **快速排除临时项目**
   ```bash
   cd /path/to/temp-project
   aicode untrack
   ```

3. **查看统计状态**
   ```bash
   aicode status
   ```
   会显示 reporter 状态和本地积压的事件数

4. **同步数据**
   ```bash
   aicode sync
   ```
   同步本地积压的事件到数据库

# ipaynow-aicode-stats

> 统计 Claude Code / Codex 等 AI 编码工具的有效代码量，自动采集 AI 生成代码的统计信息并上报到 MySQL 数据库

## ✨ 特性

- 🤖 **支持多种 AI 工具**：Claude Code、Codex 等
- 📊 **详细统计**：AI 生成行数、人工修改行数、采纳率
- 🗄️ **MySQL 存储**：结构化存储，便于查询分析
- 🎯 **模块化统计**：按代码模块分类统计
- 🚫 **智能过滤**：自动忽略 lock 文件、生成代码
- 🔒 **安全设计**：密码支持环境变量，配置文件权限 600

## 📦 安装

```bash
npm install -g ipaynow-aicode-stats
```

## 🚀 快速开始

### 1. 初始化配置

```bash
aicode init
```

会在 `~/.aicode/` 目录创建配置文件。

### 2. 配置 MySQL 连接

```bash
aicode config mysql
```

按提示输入：
- MySQL 服务器地址
- 端口（默认 3306）
- 数据库名
- 用户名
- 密码（可选，推荐用环境变量）

### 3. 创建数据库表

在 MySQL 中执行建表 SQL：

```sql
-- 查看建表 SQL
cat node_modules/ipaynow-aicode-stats/sql/schema.sql

-- 或下载后执行
mysql -h host -u user -p database < node_modules/ipaynow-aicode-stats/sql/schema.sql
```

需要创建三张表：
- `ai_commit` - 提交统计主表
- `ai_commit_file` - 文件级统计
- `ai_commit_tool` - 工具/模型级统计

### 4. 安装 Git 钩子

```bash
# 全局模式（推荐）- 所有仓库生效
aicode init --global

# 项目模式 - 仅当前仓库
cd /path/to/your-repo
aicode init
```

### 5. 验证安装

```bash
# 查看状态
aicode status

# 测试同步
aicode sync
```

## 📖 使用说明

### 基本命令

```bash
# 查看当前状态
aicode status

# 手动同步数据
aicode sync

# 重新配置 MySQL
aicode config mysql

# 管理统计名单
aicode track --list   # 查看当前配置（显示黑名单）
aicode track          # 从黑名单移除当前仓库（重新跟踪）
aicode untrack        # 添加当前仓库到黑名单（停止跟踪）
```

### 配置文件

配置文件位于 `~/.aicode/config.json`：

```json
{
  "owner": {
    "name": "你的姓名",
    "email": "your.email@example.com"
  },
  "modules": [
    { "path": "src/user/**", "name": "user-center" },
    { "path": "src/order/**", "name": "order" }
  ],
  "ignore": [
    "docs/generated/**",
    "**/*.test.ts"
  ],
  "reporter": {
    "type": "mysql",
    "options": {
      "host": "localhost",
      "port": 3306,
      "database": "ai_stats",
      "user": "aicode_writer"
    }
  },
  "track": {
    "mode": "all",
    "repos": []
  }
}
```

#### track 配置说明

- **mode: "all"** - 跟踪所有仓库（默认），`repos` 作为黑名单（不跟踪的仓库）

示例：
```json
// 跟踪除 test-project 外的所有仓库
{ "mode": "all", "repos": ["/path/to/test-project"] }

// 不排除任何仓库（跟踪所有）
{ "mode": "all", "repos": [] }
```

详细说明：[docs/track-quick-reference.md](docs/track-quick-reference.md)

### 环境变量

```bash
# 设置 MySQL 密码（推荐）
export AICODE_MYSQL_PASSWORD="your-password"
```

### 项目级配置

在仓库根目录创建 `.aicode.json` 可覆盖部分配置：

```json
{
  "modules": [
    { "path": "frontend/**", "name": "frontend" },
    { "path": "backend/**", "name": "backend" }
  ],
  "ignore": [
    "tests/fixtures/**"
  ]
}
```

## 📊 数据查询示例

### 按开发者统计

```sql
SELECT 
  owner_name,
  COUNT(*) as commits,
  SUM(added_ai) as ai_lines,
  AVG(ai_ratio) as avg_ratio
FROM ai_commit
GROUP BY owner_name
ORDER BY ai_lines DESC;
```

### 按模块统计

```sql
SELECT 
  module,
  SUM(added_total) as total_lines,
  SUM(added_ai) as ai_lines,
  AVG(ai_ratio) as avg_ratio
FROM ai_commit
GROUP BY module
ORDER BY ai_lines DESC;
```

### 按工具/模型统计

```sql
SELECT 
  tool,
  model,
  SUM(ai) as total_ai_lines,
  SUM(`generated`) as total_generated,
  ROUND(SUM(ai) / SUM(`generated`), 3) as accept_rate
FROM ai_commit_tool
GROUP BY tool, model
ORDER BY total_ai_lines DESC;
```

### 时间趋势（最近 30 天）

```sql
SELECT 
  DATE(committed_at) as date,
  COUNT(*) as commits,
  SUM(added_ai) as ai_lines,
  AVG(ai_ratio) as avg_ratio
FROM ai_commit
WHERE committed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY DATE(committed_at)
ORDER BY date;
```

## 🔧 高级配置

### 模块映射

通过 glob 模式将文件映射到模块：

```json
{
  "modules": [
    { "path": "src/user/**", "name": "user-center" },
    { "path": "src/order/**", "name": "order" },
    { "path": "src/payment/**", "name": "payment" },
    { "path": "src/common/**", "name": "common" }
  ]
}
```

### 忽略文件

自定义忽略规则（除了内置规则）：

```json
{
  "ignore": [
    "docs/generated/**",
    "**/*.test.ts",
    "**/*.spec.ts",
    "**/coverage/**"
  ]
}
```

### 只统计特定仓库

```json
{
  "track": {
    "mode": "list",
    "repos": [
      "gitlab.example.com/team/project1",
      "gitlab.example.com/team/project2"
    ]
  }
}
```

## 🛠️ 卸载

```bash
# 全局卸载
aicode uninstall --global

# 项目卸载
cd /path/to/repo
aicode uninstall

# 完全清理（包括配置文件）
rm -rf ~/.aicode
```

## 📚 文档

完整文档请查看：

- [团队安装配置手册](./docs/团队安装配置手册.md)
- [快速入门](./docs/快速入门.md)
- [配置文件示例](./docs/配置文件示例.md)

## 🤝 兼容性

### AI 工具

- ✅ Claude Code
- ✅ Codex
- ✅ 其他支持标准 diff 格式的 AI 工具

### 环境要求

- Node.js >= 18
- Git >= 2.0
- MySQL >= 5.7 或 MariaDB >= 10.2

### 操作系统

- ✅ macOS
- ✅ Linux
- ✅ Windows（需要 Git Bash 或 WSL）

## ❓ 常见问题

### Q1: GUI Git 客户端（如 Sourcetree）无法统计？

需要在配置文件中写入密码：

```json
{
  "reporter": {
    "options": {
      "password": "your-password"
    }
  }
}
```

或者在 GUI 客户端的环境变量中设置 `AICODE_MYSQL_PASSWORD`。

### Q2: 如何查看本地积压的数据？

```bash
aicode status
```

会显示本地队列中的事件数量。

### Q3: 同步失败怎么办？

```bash
# 查看详细错误
aicode sync

# 检查配置
cat ~/.aicode/config.json

# 测试 MySQL 连接
mysql -h <host> -P <port> -u <user> -p<password> <database>
```

### Q4: 如何暂时停止统计？

```bash
# 方法1: 移出名单（需要先切换到名单模式）
aicode untrack

# 方法2: 临时禁用钩子
git commit --no-verify -m "message"

# 方法3: 卸载钩子
aicode uninstall
```

### Q5: 数据库权限最小化配置？

创建专用账号，仅授予 INSERT 权限：

```sql
CREATE USER 'aicode_writer'@'%' IDENTIFIED BY 'password';
GRANT INSERT ON ai_stats.ai_commit TO 'aicode_writer'@'%';
GRANT INSERT ON ai_stats.ai_commit_file TO 'aicode_writer'@'%';
GRANT INSERT ON ai_stats.ai_commit_tool TO 'aicode_writer'@'%';
FLUSH PRIVILEGES;
```

## 📄 许可证

MIT License - 详见 [LICENSE](./LICENSE) 文件

## 🙏 致谢

本项目基于 Anthropic 的 Claude Code 和 Codex 工具链开发。

## 🐛 问题反馈

如有问题或建议，请提交 [Issue](https://github.com/IpaynowGroup/aicode-statistics/issues)。

---

**Happy Coding with AI! 🚀**

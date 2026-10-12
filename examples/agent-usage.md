# Agent 中使用 aicode 命令示例

## 1. 在 Claude Code 对话中调用

### 方式 A：直接请求
```
请帮我执行 aicode status 查看统计状态
```

### 方式 B：使用专用 Agent
```
使用 aicode-stats agent 同步数据
使用 aicode-analyzer agent 分析最近一周的代码统计
```

## 2. 在自定义 Agent 配置中使用

创建 `.claude/agents/my-agent.md`：

```markdown
---
name: my-agent
description: 我的自定义 agent
model: sonnet
tools: [Bash, Read]
---

执行 aicode 相关命令：

1. 查看状态
\`\`\`bash
aicode status
\`\`\`

2. 同步数据
\`\`\`bash
aicode sync
\`\`\`
```

## 3. 通过 API 调用

```typescript
import { Agent } from '@anthropic-ai/sdk';

const agent = new Agent({
  name: 'aicode-stats',
  prompt: '执行 aicode status 并报告结果'
});

const result = await agent.run();
console.log(result);
```

## 4. 在 CI/CD 流程中使用

```yaml
# .github/workflows/aicode-sync.yml
name: Sync AI Code Stats

on:
  schedule:
    - cron: '0 */6 * * *'  # 每 6 小时执行一次

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      - name: Install aicode
        run: npm install -g aicode-stats
      - name: Sync stats
        env:
          AICODE_MYSQL_PASSWORD: ${{ secrets.AICODE_MYSQL_PASSWORD }}
        run: |
          aicode status
          aicode sync
```

## 5. 常用命令组合

### 健康检查
```bash
aicode status && aicode sync
```

### 强制同步所有积压
```bash
while [ $(aicode status | grep -oP '本地积压：\K\d+') -gt 0 ]; do
  aicode sync
  sleep 1
done
```

### 查看统计并导出
```bash
aicode status > status.log
aicode sync 2>&1 | tee sync.log
```

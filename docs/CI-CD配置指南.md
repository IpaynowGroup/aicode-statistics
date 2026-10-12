# CI/CD 配置指南

本项目已配置 GitHub Actions 自动发布到 npm。

## 📋 工作流程

当你推送一个版本标签（如 `v1.0.0`）时，GitHub Actions 会自动：

1. ✅ 检出代码
2. ✅ 安装依赖
3. ✅ 编译 TypeScript
4. ✅ 运行测试
5. ✅ 发布到 npm

## 🔧 配置步骤

### 1. 获取 npm Access Token

1. 登录 https://www.npmjs.com/
2. 点击头像 → **Access Tokens**
3. 点击 **Generate New Token** → 选择 **Automation**
4. 复制生成的 token（格式：`npm_xxxxxxxxxxxx`）

### 2. 配置 GitHub Secrets

1. 打开 GitHub 仓库：https://github.com/IpaynowGroup/aicode-statistics
2. 进入 **Settings** → **Secrets and variables** → **Actions**
3. 点击 **New repository secret**
4. 配置如下：
   - **Name**: `NPM_TOKEN`
   - **Secret**: 粘贴刚才复制的 npm token
5. 点击 **Add secret**

### 3. 发布新版本

#### 方式 A：命令行发布（推荐）

```bash
# 1. 更新版本号
npm version patch  # 0.1.0 -> 0.1.1
# 或
npm version minor  # 0.1.0 -> 0.2.0
# 或
npm version major  # 0.1.0 -> 1.0.0

# 2. 推送代码和标签
git push && git push --tags
```

#### 方式 B：手动打标签

```bash
# 1. 手动修改 package.json 中的版本号
# 2. 提交代码
git add package.json
git commit -m "chore: bump version to 0.1.1"
git push

# 3. 打标签并推送
git tag v0.1.1
git push --tags
```

### 4. 查看发布状态

1. 打开 GitHub 仓库的 **Actions** 页面
2. 查看最新的 "Publish to npm" 工作流
3. 等待绿色 ✅ 表示发布成功

### 5. 验证发布

```bash
# 查看 npm 包信息
npm view aicode-stats

# 或访问
# https://www.npmjs.com/package/aicode-stats
```

## 🔒 安全说明

- ✅ 使用 **Automation** 类型的 token（权限最小）
- ✅ Token 存储在 GitHub Secrets 中（加密）
- ✅ 工作流使用 `--provenance` 标志（发布溯源）
- ✅ 仅在推送标签时触发（避免意外发布）

## ⚠️ 注意事项

### 包名冲突

如果 `aicode-stats` 已被占用，需要修改 `package.json`：

```json
{
  "name": "@ipaynowgroup/aicode-stats"
}
```

然后在 `.github/workflows/npm-publish.yml` 中确认使用了：

```yaml
run: npm publish --provenance --access public
```

### 测试失败

如果测试失败，工作流会中断，不会发布到 npm。这是安全保护机制。

## 📚 参考资料

- [GitHub Actions 文档](https://docs.github.com/en/actions)
- [npm 发布最佳实践](https://docs.npmjs.com/packages-and-modules/contributing-packages-to-the-registry)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)

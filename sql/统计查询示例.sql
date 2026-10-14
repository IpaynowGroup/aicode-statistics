-- AI 代码统计查询 SQL 示例
-- 所有查询均按时间倒序（最新的在前）

-- ============================================================
-- 1. 基础统计：最近的提交记录
-- ============================================================
SELECT
    commit_sha,
    repo_name,
    branch,
    author,
    tool,
    lines_added,
    lines_deleted,
    commit_message,
    created_at
FROM ai_code_commits
ORDER BY created_at DESC
LIMIT 50;


-- ============================================================
-- 2. 按用户统计：每个用户的 AI 使用情况
-- ============================================================
SELECT
    author,
    tool,
    COUNT(*) as commit_count,
    SUM(lines_added) as total_added,
    SUM(lines_deleted) as total_deleted,
    MAX(created_at) as last_commit
FROM ai_code_commits
GROUP BY author, tool
ORDER BY last_commit DESC, commit_count DESC;


-- ============================================================
-- 3. 按仓库统计：每个仓库的 AI 使用情况
-- ============================================================
SELECT
    repo_name,
    tool,
    COUNT(*) as commit_count,
    SUM(lines_added) as total_added,
    COUNT(DISTINCT author) as author_count,
    MAX(created_at) as last_commit
FROM ai_code_commits
GROUP BY repo_name, tool
ORDER BY last_commit DESC, commit_count DESC;


-- ============================================================
-- 4. 按工具统计：Claude vs Codex 对比
-- ============================================================
SELECT
    tool,
    COUNT(*) as commit_count,
    SUM(lines_added) as total_added,
    SUM(lines_deleted) as total_deleted,
    COUNT(DISTINCT author) as user_count,
    COUNT(DISTINCT repo_name) as repo_count,
    MAX(created_at) as last_used
FROM ai_code_commits
GROUP BY tool
ORDER BY last_used DESC, commit_count DESC;


-- ============================================================
-- 5. 按日期统计：最近 30 天的趋势
-- ============================================================
SELECT
    DATE(created_at) as date,
    tool,
    COUNT(*) as commit_count,
    SUM(lines_added) as total_added,
    COUNT(DISTINCT author) as active_users
FROM ai_code_commits
WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY DATE(created_at), tool
ORDER BY date DESC, tool;


-- ============================================================
-- 6. 用户 + 仓库 + 工具：三维统计
-- ============================================================
SELECT
    author,
    repo_name,
    tool,
    COUNT(*) as commit_count,
    SUM(lines_added) as total_added,
    MAX(created_at) as last_commit,
    GROUP_CONCAT(DISTINCT branch ORDER BY branch) as branches
FROM ai_code_commits
GROUP BY author, repo_name, tool
ORDER BY last_commit DESC;


-- ============================================================
-- 7. 最活跃的用户（最近 7 天）
-- ============================================================
SELECT
    author,
    tool,
    COUNT(*) as commit_count,
    SUM(lines_added) as total_added,
    MIN(created_at) as first_commit,
    MAX(created_at) as last_commit,
    DATEDIFF(MAX(created_at), MIN(created_at)) as active_days
FROM ai_code_commits
WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY author, tool
ORDER BY last_commit DESC, commit_count DESC;


-- ============================================================
-- 8. 按分支统计：不同分支的 AI 使用情况
-- ============================================================
SELECT
    repo_name,
    branch,
    tool,
    COUNT(*) as commit_count,
    SUM(lines_added) as total_added,
    COUNT(DISTINCT author) as author_count,
    MAX(created_at) as last_commit
FROM ai_code_commits
GROUP BY repo_name, branch, tool
ORDER BY last_commit DESC;


-- ============================================================
-- 9. 大提交查询：单次提交超过 100 行
-- ============================================================
SELECT
    commit_sha,
    repo_name,
    branch,
    author,
    tool,
    lines_added,
    lines_deleted,
    commit_message,
    created_at
FROM ai_code_commits
WHERE lines_added >= 100
ORDER BY created_at DESC, lines_added DESC
LIMIT 50;


-- ============================================================
-- 10. 每周统计报表：按周汇总
-- ============================================================
SELECT
    YEARWEEK(created_at, 1) as year_week,
    tool,
    COUNT(*) as commit_count,
    SUM(lines_added) as total_added,
    COUNT(DISTINCT author) as active_users,
    COUNT(DISTINCT repo_name) as active_repos
FROM ai_code_commits
GROUP BY YEARWEEK(created_at, 1), tool
ORDER BY year_week DESC, tool;


-- ============================================================
-- 11. 用户效率排名：平均每次提交行数
-- ============================================================
SELECT
    author,
    tool,
    COUNT(*) as commit_count,
    SUM(lines_added) as total_added,
    ROUND(AVG(lines_added), 2) as avg_lines_per_commit,
    MAX(created_at) as last_commit
FROM ai_code_commits
GROUP BY author, tool
HAVING commit_count >= 5  -- 至少 5 次提交
ORDER BY last_commit DESC, avg_lines_per_commit DESC;


-- ============================================================
-- 12. 仓库活跃度：最近 N 天有提交的仓库
-- ============================================================
SELECT
    repo_name,
    COUNT(*) as commit_count,
    COUNT(DISTINCT author) as contributor_count,
    COUNT(DISTINCT tool) as tool_count,
    MIN(created_at) as first_commit,
    MAX(created_at) as last_commit,
    DATEDIFF(MAX(created_at), MIN(created_at)) as active_days
FROM ai_code_commits
WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY repo_name
ORDER BY last_commit DESC, commit_count DESC;


-- ============================================================
-- 13. 完整详情：包含所有字段的查询
-- ============================================================
SELECT
    id,
    commit_sha,
    repo_name,
    branch,
    author,
    tool,
    lines_added,
    lines_deleted,
    commit_message,
    metadata,
    created_at,
    updated_at
FROM ai_code_commits
ORDER BY created_at DESC
LIMIT 100;

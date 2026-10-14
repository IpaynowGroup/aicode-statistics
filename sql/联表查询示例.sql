-- AI 代码统计联表查询 SQL 示例
-- 表结构：ai_commit (主表) + ai_commit_file (文件明细) + ai_commit_tool (工具明细)
-- 所有查询均按时间倒序（最新的在前）

-- ============================================================
-- 1. 基础联表：提交 + 工具明细
-- ============================================================
SELECT
    c.repo,
    c.branch,
    c.commit_sha,
    c.owner_name,
    c.committed_at,
    c.added_total,
    c.added_ai,
    c.ai_ratio,
    t.tool,
    t.model,
    t.ai as tool_ai_lines,
    t.generated as tool_generated_lines
FROM ai_commit c
LEFT JOIN ai_commit_tool t
    ON c.repo_key = t.repo_key
    AND c.commit_sha = t.commit_sha
ORDER BY c.committed_at DESC
LIMIT 100;


-- ============================================================
-- 2. 提交 + 文件明细：查看每个提交涉及的文件
-- ============================================================
SELECT
    c.repo,
    c.commit_sha,
    c.owner_name,
    c.committed_at,
    c.added_total,
    f.path,
    f.module,
    f.added as file_added,
    f.ai as file_ai_lines
FROM ai_commit c
LEFT JOIN ai_commit_file f
    ON c.repo_key = f.repo_key
    AND c.commit_sha = f.commit_sha
ORDER BY c.committed_at DESC, f.added DESC
LIMIT 200;


-- ============================================================
-- 3. 完整三表联查：提交 + 文件 + 工具
-- ============================================================
SELECT
    c.repo,
    c.branch,
    c.commit_sha,
    c.owner_name,
    c.committed_at,
    c.added_total,
    c.ai_ratio,
    f.path,
    f.added as file_added,
    f.ai as file_ai_lines,
    t.tool,
    t.model,
    t.ai as tool_ai_lines
FROM ai_commit c
LEFT JOIN ai_commit_file f
    ON c.repo_key = f.repo_key
    AND c.commit_sha = f.commit_sha
LEFT JOIN ai_commit_tool t
    ON c.repo_key = t.repo_key
    AND c.commit_sha = t.commit_sha
ORDER BY c.committed_at DESC
LIMIT 100;


-- ============================================================
-- 4. 按用户统计：汇总每个用户使用的工具
-- ============================================================
SELECT
    c.owner_name,
    c.owner_email,
    t.tool,
    t.model,
    COUNT(DISTINCT c.commit_sha) as commit_count,
    SUM(c.added_ai) as total_ai_lines,
    SUM(t.ai) as tool_ai_lines,
    SUM(t.generated) as tool_generated_lines,
    ROUND(AVG(c.ai_ratio), 3) as avg_ai_ratio,
    MAX(c.committed_at) as last_commit
FROM ai_commit c
INNER JOIN ai_commit_tool t
    ON c.repo_key = t.repo_key
    AND c.commit_sha = t.commit_sha
GROUP BY c.owner_name, c.owner_email, t.tool, t.model
ORDER BY last_commit DESC, total_ai_lines DESC;


-- ============================================================
-- 5. 按仓库统计：每个仓库的工具使用情况
-- ============================================================
SELECT
    c.repo,
    t.tool,
    t.model,
    COUNT(DISTINCT c.commit_sha) as commit_count,
    COUNT(DISTINCT c.owner_email) as contributor_count,
    SUM(c.added_ai) as total_ai_lines,
    SUM(t.generated) as total_generated,
    ROUND(AVG(c.ai_accept_rate), 3) as avg_accept_rate,
    MAX(c.committed_at) as last_commit
FROM ai_commit c
INNER JOIN ai_commit_tool t
    ON c.repo_key = t.repo_key
    AND c.commit_sha = t.commit_sha
GROUP BY c.repo, t.tool, t.model
ORDER BY last_commit DESC, total_ai_lines DESC;


-- ============================================================
-- 6. 按模块统计：不同模块的 AI 使用情况
-- ============================================================
SELECT
    c.module,
    t.tool,
    COUNT(DISTINCT c.commit_sha) as commit_count,
    SUM(c.added_ai) as total_ai_lines,
    SUM(c.added_human) as total_human_lines,
    ROUND(AVG(c.ai_ratio), 3) as avg_ai_ratio,
    MAX(c.committed_at) as last_commit
FROM ai_commit c
INNER JOIN ai_commit_tool t
    ON c.repo_key = t.repo_key
    AND c.commit_sha = t.commit_sha
GROUP BY c.module, t.tool
ORDER BY last_commit DESC, total_ai_lines DESC;


-- ============================================================
-- 7. 文件热度排行：哪些文件被 AI 修改最多
-- ============================================================
SELECT
    f.path,
    f.module,
    COUNT(DISTINCT f.commit_sha) as commit_count,
    SUM(f.added) as total_added,
    SUM(f.ai) as total_ai_lines,
    ROUND(AVG(f.ai * 1.0 / NULLIF(f.added, 0)), 3) as avg_ai_ratio,
    MAX(c.committed_at) as last_modified
FROM ai_commit_file f
INNER JOIN ai_commit c
    ON f.repo_key = c.repo_key
    AND f.commit_sha = c.commit_sha
GROUP BY f.path, f.module
HAVING commit_count >= 2  -- 至少被修改 2 次
ORDER BY last_modified DESC, total_ai_lines DESC
LIMIT 50;


-- ============================================================
-- 8. 工具对比分析：Claude Code vs Codex
-- ============================================================
SELECT
    t.tool,
    t.model,
    COUNT(DISTINCT c.commit_sha) as commit_count,
    COUNT(DISTINCT c.owner_email) as user_count,
    COUNT(DISTINCT c.repo) as repo_count,
    SUM(t.ai) as total_ai_lines,
    SUM(t.generated) as total_generated,
    ROUND(AVG(c.ai_accept_rate), 3) as avg_accept_rate,
    ROUND(AVG(t.ai * 1.0 / NULLIF(t.generated, 0)), 3) as avg_acceptance,
    MAX(c.committed_at) as last_used
FROM ai_commit_tool t
INNER JOIN ai_commit c
    ON t.repo_key = c.repo_key
    AND t.commit_sha = c.commit_sha
GROUP BY t.tool, t.model
ORDER BY last_used DESC, total_ai_lines DESC;


-- ============================================================
-- 9. 按日期统计：每天的提交趋势（含工具拆分）
-- ============================================================
SELECT
    DATE(c.committed_at) as date,
    t.tool,
    COUNT(DISTINCT c.commit_sha) as commit_count,
    COUNT(DISTINCT c.owner_email) as active_users,
    SUM(c.added_ai) as total_ai_lines,
    SUM(t.generated) as total_generated,
    ROUND(AVG(c.ai_ratio), 3) as avg_ai_ratio
FROM ai_commit c
INNER JOIN ai_commit_tool t
    ON c.repo_key = t.repo_key
    AND c.commit_sha = t.commit_sha
WHERE c.committed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY DATE(c.committed_at), t.tool
ORDER BY date DESC, t.tool;


-- ============================================================
-- 10. 用户效率分析：生成率和接受率
-- ============================================================
SELECT
    c.owner_name,
    c.owner_email,
    t.tool,
    COUNT(DISTINCT c.commit_sha) as commit_count,
    SUM(t.generated) as total_generated,
    SUM(t.ai) as total_accepted,
    ROUND(AVG(c.ai_accept_rate), 3) as avg_accept_rate,
    ROUND(SUM(t.ai) * 1.0 / NULLIF(SUM(t.generated), 0), 3) as actual_accept_rate,
    MAX(c.committed_at) as last_commit
FROM ai_commit c
INNER JOIN ai_commit_tool t
    ON c.repo_key = t.repo_key
    AND c.commit_sha = t.commit_sha
GROUP BY c.owner_name, c.owner_email, t.tool
HAVING commit_count >= 5  -- 至少 5 次提交
ORDER BY last_commit DESC, actual_accept_rate DESC;


-- ============================================================
-- 11. 大文件修改排行：单次文件修改超过 50 行
-- ============================================================
SELECT
    c.repo,
    c.commit_sha,
    c.owner_name,
    c.committed_at,
    f.path,
    f.added as file_added,
    f.ai as file_ai_lines,
    ROUND(f.ai * 1.0 / NULLIF(f.added, 0), 3) as file_ai_ratio,
    t.tool,
    t.model
FROM ai_commit_file f
INNER JOIN ai_commit c
    ON f.repo_key = c.repo_key
    AND f.commit_sha = c.commit_sha
LEFT JOIN ai_commit_tool t
    ON f.repo_key = t.repo_key
    AND f.commit_sha = t.commit_sha
WHERE f.added >= 50
ORDER BY c.committed_at DESC, f.added DESC
LIMIT 100;


-- ============================================================
-- 12. 按分支统计：不同分支的工具使用情况
-- ============================================================
SELECT
    c.repo,
    c.branch,
    t.tool,
    COUNT(DISTINCT c.commit_sha) as commit_count,
    COUNT(DISTINCT c.owner_email) as contributor_count,
    SUM(c.added_ai) as total_ai_lines,
    ROUND(AVG(c.ai_ratio), 3) as avg_ai_ratio,
    MAX(c.committed_at) as last_commit
FROM ai_commit c
INNER JOIN ai_commit_tool t
    ON c.repo_key = t.repo_key
    AND c.commit_sha = t.commit_sha
GROUP BY c.repo, c.branch, t.tool
ORDER BY last_commit DESC, total_ai_lines DESC;


-- ============================================================
-- 13. Amend 提交统计：修改提交的分析
-- ============================================================
SELECT
    c.repo,
    c.commit_sha,
    c.owner_name,
    c.committed_at,
    c.amend,
    c.added_ai,
    c.ai_ratio,
    t.tool,
    t.model,
    GROUP_CONCAT(DISTINCT f.path ORDER BY f.added DESC SEPARATOR ', ') as top_files
FROM ai_commit c
INNER JOIN ai_commit_tool t
    ON c.repo_key = t.repo_key
    AND c.commit_sha = t.commit_sha
LEFT JOIN ai_commit_file f
    ON c.repo_key = f.repo_key
    AND c.commit_sha = f.commit_sha
WHERE c.amend = 1
GROUP BY c.repo, c.commit_sha, c.owner_name, c.committed_at, c.amend, c.added_ai, c.ai_ratio, t.tool, t.model
ORDER BY c.committed_at DESC
LIMIT 50;


-- ============================================================
-- 14. 每周趋势报表：工具使用周报
-- ============================================================
SELECT
    YEARWEEK(c.committed_at, 1) as year_week,
    t.tool,
    t.model,
    COUNT(DISTINCT c.commit_sha) as commit_count,
    COUNT(DISTINCT c.owner_email) as active_users,
    COUNT(DISTINCT c.repo) as active_repos,
    SUM(c.added_ai) as total_ai_lines,
    SUM(t.generated) as total_generated,
    ROUND(AVG(c.ai_accept_rate), 3) as avg_accept_rate
FROM ai_commit c
INNER JOIN ai_commit_tool t
    ON c.repo_key = t.repo_key
    AND c.commit_sha = t.commit_sha
GROUP BY YEARWEEK(c.committed_at, 1), t.tool, t.model
ORDER BY year_week DESC, t.tool, t.model;


-- ============================================================
-- 15. 最近活跃用户：含文件修改明细
-- ============================================================
SELECT
    c.owner_name,
    c.owner_email,
    COUNT(DISTINCT c.commit_sha) as commit_count,
    COUNT(DISTINCT f.path) as file_count,
    SUM(c.added_ai) as total_ai_lines,
    ROUND(AVG(c.ai_ratio), 3) as avg_ai_ratio,
    MAX(c.committed_at) as last_commit,
    GROUP_CONCAT(DISTINCT t.tool ORDER BY t.tool SEPARATOR ', ') as tools_used
FROM ai_commit c
LEFT JOIN ai_commit_file f
    ON c.repo_key = f.repo_key
    AND c.commit_sha = f.commit_sha
LEFT JOIN ai_commit_tool t
    ON c.repo_key = t.repo_key
    AND c.commit_sha = t.commit_sha
WHERE c.committed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY c.owner_name, c.owner_email
ORDER BY last_commit DESC, total_ai_lines DESC;

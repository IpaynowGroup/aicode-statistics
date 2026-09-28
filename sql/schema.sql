-- aicode 统计表，兼容 MySQL 5.6 及以上版本（字符集 utf8mb4）。
-- 由 DBA 执行。客户端账号只需要 INSERT 权限，即使泄露也无法读取、修改或删除数据：
--   CREATE USER 'aicode_writer'@'%' IDENTIFIED BY '<密码>';
--   GRANT INSERT ON ai_stats.ai_commit      TO 'aicode_writer'@'%';
--   GRANT INSERT ON ai_stats.ai_commit_file TO 'aicode_writer'@'%';
--   GRANT INSERT ON ai_stats.ai_commit_tool TO 'aicode_writer'@'%';
-- MySQL 5.6 单列索引上限 767 字节，因此主键使用 ASCII 哈希列。

CREATE TABLE IF NOT EXISTS ai_commit (
  repo_key        CHAR(16)     CHARACTER SET ascii NOT NULL COMMENT 'repo 的 sha1 前 16 位',
  commit_sha      CHAR(40)     CHARACTER SET ascii NOT NULL,
  repo            VARCHAR(255) NOT NULL COMMENT '如 gitlab.example.com/group/project',
  branch          VARCHAR(255) NOT NULL,
  parent_sha      CHAR(40)     CHARACTER SET ascii NULL,
  commit_message  TEXT         NOT NULL,
  committed_at    DATETIME     NOT NULL COMMENT 'UTC',
  amend           TINYINT(1)   NOT NULL DEFAULT 0,
  owner_name      VARCHAR(128) NOT NULL,
  owner_email     VARCHAR(255) NOT NULL,
  module          VARCHAR(128) NOT NULL,
  added_total     INT          NOT NULL,
  added_ai        INT          NOT NULL,
  added_human     INT          NOT NULL,
  deleted_total   INT          NOT NULL,
  ai_ratio        DECIMAL(5,3) NOT NULL,
  ai_generated    INT          NOT NULL,
  ai_accept_rate  DECIMAL(5,3) NOT NULL,
  client_version  VARCHAR(32)  NOT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repo_key, commit_sha),
  KEY idx_repo_time (repo_key, committed_at),
  KEY idx_owner_time (owner_email(191), committed_at),
  KEY idx_module_time (module, committed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='每个 commit 的 AI 代码统计';

CREATE TABLE IF NOT EXISTS ai_commit_file (
  repo_key    CHAR(16)      CHARACTER SET ascii NOT NULL,
  commit_sha  CHAR(40)      CHARACTER SET ascii NOT NULL,
  path_sha1   CHAR(40)      CHARACTER SET ascii NOT NULL,
  path        VARCHAR(1024) NOT NULL,
  module      VARCHAR(128)  NOT NULL,
  added       INT           NOT NULL,
  ai          INT           NOT NULL,
  PRIMARY KEY (repo_key, commit_sha, path_sha1),
  KEY idx_module (module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='每个 commit 中各文件的统计';

CREATE TABLE IF NOT EXISTS ai_commit_tool (
  repo_key    CHAR(16)     CHARACTER SET ascii NOT NULL,
  commit_sha  CHAR(40)     CHARACTER SET ascii NOT NULL,
  tool        VARCHAR(32)  CHARACTER SET ascii NOT NULL COMMENT 'claude-code / codex',
  model       VARCHAR(128) CHARACTER SET ascii NOT NULL,
  ai          INT          NOT NULL COMMENT '被提交的 AI 行数',
  generated   INT          NOT NULL COMMENT 'AI 生成的行数',
  PRIMARY KEY (repo_key, commit_sha, tool, model)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='每个 commit 按工具/模型拆分的统计';

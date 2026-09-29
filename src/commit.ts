import { analyzeCommit } from './analyzer.js';
import { loadConfig } from './config.js';
import { appendEvent, hasEvent, type CommitEvent } from './events.js';
import { commitDiff, commitInfo, currentBranch, isAmend, repoId, repoKey, repoRoot, tryGit } from './git.js';
import { buildIgnore } from './ignore.js';
import { readRecords, withLock, writeRecords } from './ledger.js';
import { commitModule, createModuleResolver, resolveOwner } from './metadata.js';
import { loadReporter } from './reporter/index.js';
import { autoSync } from './sync.js';
import { isRepoTracked } from './track.js';
import { VERSION } from './version.js';

export const LEDGER_TTL_SECONDS = 7 * 86400;

export interface RunCommitOptions { sha?: string; branch?: string; reflog?: string; prev?: string }

export async function runCommit(cwd: string, opts?: RunCommitOptions): Promise<CommitEvent | null> {
  const root = repoRoot(cwd);
  if (!root) return null;
  if (!isRepoTracked(root)) return null;
  const info = commitInfo(root, opts?.sha ?? 'HEAD');
  if (info.parents.length > 1) return null; // merge commit 不统计
  const id = repoId(root);
  const eventId = `${id}:${info.sha}`;

  const config = loadConfig(root);
  const branch = opts?.branch ?? currentBranch(root);
  const isIgnored = buildIgnore(root, config.ignore);
  const moduleOf = createModuleResolver(config.modules, branch);
  const diffs = commitDiff(root, info.sha);
  const key = repoKey(id);

  // hook 同步捕获的 reflog 优先于事后重新读取，避免读到晚到的状态（见 F1）
  const amend = opts?.reflog !== undefined ? opts.reflog.startsWith('commit (amend)') : isAmend(root);
  // amend 场景下把旧 commit 名下已消费的 AI 行临时借回，保留其 AI 归属（见 F3）
  const reusableSha = amend ? opts?.prev ?? tryGit(root, ['rev-parse', '-q', '--verify', 'HEAD@{1}'])?.trim() ?? undefined : undefined;
  const owner = resolveOwner(config, { name: info.authorName, email: info.authorEmail });

  const event = withLock(key, (): CommitEvent | null => {
    if (hasEvent(eventId)) return null; // 在锁内判重，避免两个进程同时统计
    const r = analyzeCommit(diffs, readRecords(key), isIgnored, moduleOf, info.sha, reusableSha);
    const cutoff = Math.floor(Date.now() / 1000) - LEDGER_TTL_SECONDS;
    writeRecords(key, r.records.filter((rec) => rec.ts >= cutoff));
    const e: CommitEvent = {
      event_id: eventId,
      repo: id,
      branch,
      commit_sha: info.sha,
      parent_sha: info.parents[0] ?? null,
      commit_message: info.message,
      committed_at: info.committedAt,
      amend,
      owner,
      module: commitModule(r.files),
      stats: r.stats,
      files: r.files,
      client_version: VERSION,
    };
    appendEvent(e);
    return e;
  });
  if (!event) return null;
  await autoSync(await loadReporter(config.reporter));
  return event;
}

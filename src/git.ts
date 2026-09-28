import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string | null {
  const out = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  return out ? out.trim() : null;
}

function nearestExistingDir(absPath: string): string | null {
  let dir = path.dirname(absPath);
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return dir;
}

export function repoRootForPath(absPath: string): string | null {
  const dir = nearestExistingDir(absPath);
  return dir ? repoRoot(dir) : null;
}

/** 转为仓库相对路径（POSIX 分隔符）；先 realpath 已存在的祖先目录，以兼容 /var → /private/var 这类软链 */
export function toRepoRelative(root: string, absPath: string): string {
  const dir = nearestExistingDir(absPath) ?? path.dirname(absPath);
  const rest = path.relative(dir, absPath);
  const real = path.join(fs.realpathSync(dir), rest);
  return path.relative(root, real).split(path.sep).join('/');
}

export function normalizeRemote(url: string): string {
  const u = url.trim().replace(/\.git$/, '');
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(u);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const parsed = new URL(u);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return u;
  }
}

export function repoId(root: string): string {
  const url = tryGit(root, ['config', '--get', 'remote.origin.url'])?.trim();
  return url ? normalizeRemote(url) : `local:${root}`;
}

export function repoKey(id: string): string {
  return createHash('sha1').update(id).digest('hex').slice(0, 16);
}

export function currentBranch(root: string): string {
  return tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() ?? 'HEAD';
}

/** 已改动（含未跟踪）文件的仓库相对路径；重命名只保留新路径 */
export function statusPaths(root: string): string[] {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    paths.push(entry.slice(3));
    if (x === 'R' || x === 'C') i++; // -z 模式下紧跟一个原路径条目
  }
  return paths;
}

export function showFile(root: string, rev: string, rel: string): string | null {
  return tryGit(root, ['show', `${rev}:${rel}`]);
}

export interface CommitInfo {
  sha: string;
  parents: string[];
  committedAt: string;
  authorName: string;
  authorEmail: string;
  message: string;
}

export function commitInfo(root: string, rev: string): CommitInfo {
  const out = git(root, ['log', '-1', '--format=%H%x1f%P%x1f%cI%x1f%an%x1f%ae%x1f%B', rev]);
  const [sha, parents, committedAt, authorName, authorEmail, message] = out.split('\x1f');
  return {
    sha,
    parents: parents.trim() ? parents.trim().split(' ') : [],
    committedAt,
    authorName,
    authorEmail,
    message: message.trim(),
  };
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  added: string[];
  deleted: number;
  binary: boolean;
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { path: '', oldPath: null, added: [], deleted: 0, binary: false };
      files.push(cur);
      inHunk = false;
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m) cur.path = m[2];
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('rename from ')) cur.oldPath = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.path = line.slice('rename to '.length);
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') cur.path = line.slice(4).replace(/^b\//, '');
      else if (line.startsWith('Binary files ')) cur.binary = true;
      continue;
    }
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.deleted++;
  }
  return files;
}

export function commitDiff(root: string, sha: string): FileDiff[] {
  return parseUnifiedDiff(git(root, ['show', '--pretty=format:', '-U0', '--no-color', '--no-ext-diff', '-M', sha]));
}

export function isAmend(root: string): boolean {
  return (tryGit(root, ['reflog', '-1', '--format=%gs']) ?? '').startsWith('commit (amend)');
}

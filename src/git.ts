import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** timeoutMs 传入时由 execFileSync 强制超时终止子进程，避免钩子路径被 git 卡死（见 F4） */
export function git(cwd: string, args: string[], timeoutMs?: number): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
    ...(timeoutMs !== undefined ? { timeout: timeoutMs, killSignal: 'SIGKILL' as const } : {}),
  });
}

export function tryGit(cwd: string, args: string[], timeoutMs?: number): string | null {
  try {
    return git(cwd, args, timeoutMs);
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

/** git status 参数；--no-optional-locks 避免与用户操作竞争 .git/index.lock（git ≥ 2.15，见 F4） */
export function buildStatusArgs(): string[] {
  return ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'];
}

/** 已改动（含未跟踪）文件的仓库相对路径；重命名只保留新路径 */
export function statusPaths(root: string, timeoutMs?: number): string[] {
  const out = git(root, buildStatusArgs(), timeoutMs);
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

export function showFile(root: string, rev: string, rel: string, timeoutMs?: number): string | null {
  return tryGit(root, ['show', `${rev}:${rel}`], timeoutMs);
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

/** git 用 C 风格引号包裹含特殊字符（引号、反斜杠）或非 ASCII 字节（core.quotepath 默认开启）的路径 */
function unquotePath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  const singleEscapes: Record<string, number> = {
    '"': 0x22, '\\': 0x5c, 'n': 0x0a, 't': 0x09, 'a': 0x07, 'b': 0x08, 'f': 0x0c, 'r': 0x0d, 'v': 0x0b,
  };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') {
      bytes.push(c.charCodeAt(0));
      continue;
    }
    const next = inner[i + 1];
    if (next >= '0' && next <= '7') {
      let oct = '';
      let j = i + 1;
      while (j < inner.length && oct.length < 3 && inner[j] >= '0' && inner[j] <= '7') {
        oct += inner[j];
        j++;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      i = j - 1;
      continue;
    }
    if (next in singleEscapes) {
      bytes.push(singleEscapes[next]);
      i++;
      continue;
    }
    bytes.push(next.charCodeAt(0));
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** 去掉一个可能存在的、用于消除路径末尾空白歧义的尾部 \t，再做去引号处理 */
function cleanDiffPath(raw: string): string {
  const trimmed = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
  return unquotePath(trimmed);
}

/** diff --git 行在路径需要引号时，整个 a/xxx、b/xxx 一起被引号包裹（含前缀） */
function parseDiffGitLine(line: string): { a: string; b: string } | null {
  const rest = line.slice('diff --git '.length);
  const plain = /^a\/(.*) b\/(.*)$/.exec(rest);
  if (plain) return { a: plain[1], b: plain[2] };
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted) return { a: unquotePath(quoted[1]).replace(/^a\//, ''), b: unquotePath(quoted[2]).replace(/^b\//, '') };
  const mixed = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
  if (mixed) {
    return {
      a: unquotePath(mixed[1]).replace(/^a\//, ''),
      b: unquotePath(mixed[2]).replace(/^b\//, ''),
    };
  }
  return null;
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
      const m = parseDiffGitLine(line);
      if (m) cur.path = m.b;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('rename from ')) cur.oldPath = cleanDiffPath(line.slice('rename from '.length));
      else if (line.startsWith('rename to ')) cur.path = cleanDiffPath(line.slice('rename to '.length));
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') cur.path = cleanDiffPath(line.slice(4)).replace(/^b\//, '');
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

export function gitCommonDir(repo: string): string {
  return path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']).trim());
}

export function isTracked(repo: string, rel: string): boolean {
  return tryGit(repo, ['ls-files', '--error-unmatch', rel]) !== null;
}

/** 仓库级 core.hooksPath（如 husky），存在时全局与项目模式的 hook 都不会被 git 调用 */
export function localHooksPath(repo: string): string | null {
  return tryGit(repo, ['config', '--local', '--get', 'core.hooksPath'])?.trim() || null;
}

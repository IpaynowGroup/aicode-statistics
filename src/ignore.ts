import fs from 'node:fs';
import path from 'node:path';

export type IgnoreFn = (rel: string) => boolean;

// 参考 git-ai 的默认忽略列表：锁文件、压缩产物、依赖目录、快照、protobuf 生成代码
export const DEFAULT_IGNORE: string[] = [
  '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'go.sum', 'Gemfile.lock', 'poetry.lock',
  'composer.lock', 'Pipfile.lock', 'shrinkwrap.yaml', '*.generated.*', '*.min.js', '*.min.css', '*.map',
  '**/vendor/**', '**/node_modules/**', '**/__snapshots__/**', '**/*.snap',
  '*.pb.go', '*.pb.h', '*.pb.cc', '*_pb2.py', '*_pb2_grpc.py', '*.pb.swift', '*.pb.dart',
];

/** 支持 **、*、?；不含 / 的模式匹配任意层级文件名；以 / 结尾表示目录 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/^\//, '');
  if (g.endsWith('/')) g += '**';
  if (!g.includes('/')) g = `**/${g}`;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function parseLinguistGenerated(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    if (attrs.some((a) => a === 'linguist-generated' || a === 'linguist-generated=true')) out.push(pattern);
  }
  return out;
}

export function buildIgnore(repoRoot: string | null, extra: string[]): IgnoreFn {
  let linguist: string[] = [];
  if (repoRoot) {
    try {
      linguist = parseLinguistGenerated(fs.readFileSync(path.join(repoRoot, '.gitattributes'), 'utf8'));
    } catch {
      // 没有 .gitattributes
    }
  }
  const patterns = [...DEFAULT_IGNORE, ...linguist, ...extra].map(globToRegExp);
  return (rel) => patterns.some((re) => re.test(rel));
}

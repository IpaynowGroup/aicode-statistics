import type { FileStat } from './analyzer.js';
import type { AicodeConfig, ModuleRule } from './config.js';
import { globToRegExp } from './ignore.js';

export function moduleFromBranch(branch: string): string {
  const m = /^(?:feature|hotfix)\/(.+)$/.exec(branch);
  return m ? m[1] : 'unknown';
}

export function createModuleResolver(rules: ModuleRule[], branch: string): (path: string) => string {
  const compiled = rules.map((r) => ({ re: globToRegExp(r.path), name: r.name }));
  const fallback = moduleFromBranch(branch);
  return (p) => compiled.find((c) => c.re.test(p))?.name ?? fallback;
}

/** 按模块汇总新增行，取最多的；平局取先出现的 */
export function commitModule(files: FileStat[]): string {
  const totals = new Map<string, number>();
  for (const f of files) totals.set(f.module, (totals.get(f.module) ?? 0) + f.added);
  let best = 'unknown';
  let max = -1;
  for (const [module, n] of totals) {
    if (n > max) {
      best = module;
      max = n;
    }
  }
  return best;
}

export function resolveOwner(config: AicodeConfig, author: { name: string; email: string }): { name: string; email: string } {
  return { name: config.owner?.name ?? author.name, email: config.owner?.email ?? author.email };
}

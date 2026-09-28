import { createHash } from 'node:crypto';

// 只由括号、分号、逗号（及其间空白）组成的行不计入统计
const PUNCT_ONLY = /^[{}()[\];,\s]+$/;

export function normalizeLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '' || PUNCT_ONLY.test(trimmed)) return null;
  return trimmed;
}

export function fingerprint(line: string): string | null {
  const normalized = normalizeLine(line);
  if (normalized === null) return null;
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

export function fingerprintLines(lines: Iterable<string>): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const fp = fingerprint(line);
    if (fp !== null) out.push(fp);
  }
  return out;
}

export function fingerprintText(text: string): string[] {
  return fingerprintLines(text.split(/\r?\n/));
}

/** 多重集合差：after 中比 before 多出的元素（按出现次数） */
export function multisetDiff(after: string[], before: string[]): string[] {
  const counts = new Map<string, number>();
  for (const fp of before) counts.set(fp, (counts.get(fp) ?? 0) + 1);
  const out: string[] = [];
  for (const fp of after) {
    const c = counts.get(fp) ?? 0;
    if (c > 0) counts.set(fp, c - 1);
    else out.push(fp);
  }
  return out;
}

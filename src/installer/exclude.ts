import fs from 'node:fs';
import path from 'node:path';
import { gitCommonDir } from '../git.js';

// .gitignore 语法不支持行尾注释，所以用首尾标记行包住 aicode 写入的条目
const BEGIN = '# >>> aicode >>>';
const END = '# <<< aicode <<<';

function excludeFile(repo: string): string {
  return path.join(gitCommonDir(repo), 'info', 'exclude');
}

function strip(text: string): string {
  return text.replace(new RegExp(`${BEGIN}\\n[\\s\\S]*?${END}\\n`, 'g'), '');
}

export function addExclude(repo: string, patterns: string[]): void {
  const file = excludeFile(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = fs.existsSync(file) ? strip(fs.readFileSync(file, 'utf8')) : '';
  if (text.length && !text.endsWith('\n')) text += '\n';
  fs.writeFileSync(file, `${text}${BEGIN}\n${patterns.join('\n')}\n${END}\n`);
}

export function removeExclude(repo: string): void {
  const file = excludeFile(repo);
  if (fs.existsSync(file)) fs.writeFileSync(file, strip(fs.readFileSync(file, 'utf8')));
}

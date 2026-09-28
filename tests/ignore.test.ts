import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIgnore, globToRegExp, parseLinguistGenerated } from '../src/ignore.js';
import { initRepo } from './helpers.js';

describe('globToRegExp', () => {
  const m = (g: string, p: string) => globToRegExp(g).test(p);
  it('不含 / 的模式匹配任意层级的文件名', () => {
    expect(m('*.lock', 'a/b/yarn.lock')).toBe(true);
    expect(m('Cargo.lock', 'x/Cargo.lock')).toBe(true);
  });
  it('** 跨目录', () => {
    expect(m('**/vendor/**', 'vendor/x.go')).toBe(true);
    expect(m('**/vendor/**', 'a/vendor/x.go')).toBe(true);
    expect(m('src/user/**', 'src/user/a/b.ts')).toBe(true);
    expect(m('src/user/**', 'src/order/a.ts')).toBe(false);
  });
  it('* 不跨目录，? 匹配单个字符', () => {
    expect(m('src/*.ts', 'src/a.ts')).toBe(true);
    expect(m('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(m('a?.js', 'ab.js')).toBe(true);
  });
  it('以 / 结尾表示目录', () => expect(m('dist/', 'dist/a.js')).toBe(true));
  it('转义正则特殊字符', () => expect(m('a+b.ts', 'a+b.ts')).toBe(true));
});

describe('parseLinguistGenerated', () => {
  it('只取标记为 linguist-generated 的模式', () => {
    const content = '# c\ngen/** linguist-generated\n*.pb.ts linguist-generated=true\nx.ts -linguist-generated\ny.ts text\n';
    expect(parseLinguistGenerated(content)).toEqual(['gen/**', '*.pb.ts']);
  });
});

describe('buildIgnore', () => {
  it('合并默认规则、linguist-generated 与额外规则', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'gen/** linguist-generated\n');
    const ignored = buildIgnore(repo, ['docs/**']);
    expect(ignored('package-lock.json')).toBe(true);
    expect(ignored('web/node_modules/a.js')).toBe(true);
    expect(ignored('gen/a.ts')).toBe(true);
    expect(ignored('docs/a.md')).toBe(true);
    expect(ignored('src/a.ts')).toBe(false);
  });
});

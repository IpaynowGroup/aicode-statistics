import { describe, expect, it } from 'vitest';
import { commitModule, createModuleResolver, moduleFromBranch, resolveOwner } from '../src/metadata.js';

describe('metadata', () => {
  it('从分支名提取模块', () => {
    expect(moduleFromBranch('feature/login-v2')).toBe('login-v2');
    expect(moduleFromBranch('hotfix/pay-timeout')).toBe('pay-timeout');
    expect(moduleFromBranch('main')).toBe('unknown');
  });

  it('按规则顺序匹配，未命中时退回分支模块', () => {
    const of = createModuleResolver([{ path: 'src/user/**', name: 'user-center' }, { path: 'src/**', name: 'core' }], 'feature/x');
    expect(of('src/user/a.ts')).toBe('user-center');
    expect(of('src/b.ts')).toBe('core');
    expect(of('docs/a.md')).toBe('x');
  });

  it('commit 级模块取新增行最多的那个', () => {
    expect(commitModule([{ path: 'a', module: 'm1', added: 3, ai: 0 }, { path: 'b', module: 'm2', added: 2, ai: 0 }, { path: 'c', module: 'm2', added: 2, ai: 0 }])).toBe('m2');
    expect(commitModule([])).toBe('unknown');
  });

  it('owner 以配置优先', () => {
    const author = { name: 'git名', email: 'git@x.com' };
    expect(resolveOwner({ modules: [], ignore: [], reporter: { type: 'noop' } }, author)).toEqual(author);
    expect(resolveOwner({ owner: { name: '张三' }, modules: [], ignore: [], reporter: { type: 'noop' } }, author)).toEqual({ name: '张三', email: 'git@x.com' });
  });
});

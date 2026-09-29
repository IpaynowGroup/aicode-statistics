import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, writeDefaultConfig } from '../src/config.js';
import { configPath, logPath } from '../src/paths.js';
import { initRepo, tmpHome } from './helpers.js';

describe('loadConfig', () => {
  beforeEach(() => tmpHome());

  it('没有配置文件时返回默认值', () => {
    expect(loadConfig(null)).toEqual({
      owner: undefined, modules: [], ignore: [], reporter: { type: 'noop' }, track: { mode: 'all', repos: [] },
    });
  });

  it('loadConfig().track 每次都是新对象，修改一次的结果不会污染下一次调用（见默认值防污染）', () => {
    const first = loadConfig(null).track;
    first.repos.push('mutated');
    first.mode = 'list';
    const second = loadConfig(null).track;
    expect(second).toEqual({ mode: 'all', repos: [] });
  });

  it('仓库级 .aicode.json 写 track 不生效（只认全局配置）', () => {
    writeDefaultConfig();
    const global = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    global.track = { mode: 'list', repos: ['gitlab.example.com/group/global'] };
    fs.writeFileSync(configPath(), JSON.stringify(global));
    const repo = initRepo();
    fs.writeFileSync(
      path.join(repo, '.aicode.json'),
      JSON.stringify({ track: { mode: 'list', repos: ['gitlab.example.com/group/evil'] } }),
    );
    expect(loadConfig(repo).track).toEqual({ mode: 'list', repos: ['gitlab.example.com/group/global'] });
  });

  it('仓库配置覆盖 owner/modules/ignore，但不能覆盖 reporter', () => {
    writeDefaultConfig();
    const global = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    global.owner = { name: '全局' };
    global.reporter = { type: 'module', module: '/safe.js' };
    fs.writeFileSync(configPath(), JSON.stringify(global));
    const repo = initRepo();
    fs.writeFileSync(
      path.join(repo, '.aicode.json'),
      JSON.stringify({ owner: { name: '仓库' }, modules: [{ path: 'src/**', name: 'core' }], reporter: { type: 'module', module: '/evil.js' } }),
    );
    const cfg = loadConfig(repo);
    expect(cfg.owner).toEqual({ name: '仓库' });
    expect(cfg.modules).toEqual([{ path: 'src/**', name: 'core' }]);
    expect(cfg.reporter).toEqual({ type: 'module', module: '/safe.js' });
  });

  it('JSON 损坏时忽略该文件', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), '{bad');
    expect(loadConfig(null).reporter).toEqual({ type: 'noop' });
  });

  it('全局配置顶层不是普通对象（如 null）时忽略该文件而不是抛错', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), 'null');
    expect(loadConfig(null)).toEqual({
      owner: undefined, modules: [], ignore: [], reporter: { type: 'noop' }, track: { mode: 'all', repos: [] },
    });
  });

  it('仓库级 .aicode.json 顶层不是普通对象（如数组）时忽略该文件', () => {
    writeDefaultConfig();
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, '.aicode.json'), '[1,2,3]');
    expect(loadConfig(repo).modules).toEqual([]);
  });

  it('字段类型错误时忽略该字段并记日志，不影响其他字段（见 F8）', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ owner: 'not-an-object', modules: 'not-an-array', ignore: { a: 1 }, reporter: { type: 'noop' } }));
    const cfg = loadConfig(null);
    expect(cfg.owner).toBeUndefined();
    expect(cfg.modules).toEqual([]);
    expect(cfg.ignore).toEqual([]);
    const log = fs.readFileSync(logPath(), 'utf8');
    expect(log).toContain('owner');
    expect(log).toContain('modules');
    expect(log).toContain('ignore');
  });
});

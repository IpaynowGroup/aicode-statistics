import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readGlobalConfig, updateGlobalConfig } from '../src/config.js';
import { repoId } from '../src/git.js';
import { configPath } from '../src/paths.js';
import {
  addToTrackList, describeTrack, isRepoTracked, removeFromTrackList, setTrackAll, trackRepo, untrackRepo,
} from '../src/track.js';
import { initRepo, sh, tmpHome } from './helpers.js';

beforeEach(() => tmpHome());

describe('updateGlobalConfig', () => {
  it('保留未知字段（reporter、自定义 foo），写后权限为 600', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ reporter: { type: 'noop' }, foo: 'bar' }));
    updateGlobalConfig((raw) => {
      raw.track = { mode: 'list', repos: ['x'] };
    });
    const raw = readGlobalConfig();
    expect(raw.reporter).toEqual({ type: 'noop' });
    expect(raw.foo).toBe('bar');
    expect(raw.track).toEqual({ mode: 'list', repos: ['x'] });
    expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it('配置文件不存在时从空对象开始，目录权限为 700', () => {
    updateGlobalConfig((raw) => {
      raw.track = { mode: 'all', repos: [] };
    });
    expect(fs.statSync(path.dirname(configPath())).mode & 0o777).toBe(0o700);
    expect(readGlobalConfig().track).toEqual({ mode: 'all', repos: [] });
  });

  it('文件存在但 JSON 损坏时拒绝写入：原文件字节不变，且抛错（不静默覆盖 reporter/密码等字段）', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    const corrupt = '{ "reporter": { "type": "mysql", "options": { "password": "secret" } }, }'; // 尾随逗号，非法 JSON
    fs.writeFileSync(configPath(), corrupt);
    expect(() => updateGlobalConfig((raw) => {
      raw.track = { mode: 'list', repos: ['x'] };
    })).toThrow('解析失败');
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(corrupt);
    expect(fs.existsSync(`${configPath()}.tmp`)).toBe(false);
  });

  it('文件解析结果不是普通对象（如数组）时同样拒绝写入', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    const notObject = '[1, 2, 3]';
    fs.writeFileSync(configPath(), notObject);
    expect(() => updateGlobalConfig(() => {})).toThrow('解析失败');
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(notObject);
  });

  it('写入后不留 .tmp 临时文件，文件权限为 600', () => {
    updateGlobalConfig((raw) => {
      raw.track = { mode: 'list', repos: ['y'] };
    });
    expect(fs.existsSync(`${configPath()}.tmp`)).toBe(false);
    expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it('临时文件名带上当前进程 pid，避免并发写入者互相覆盖（控制器裁定）', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    updateGlobalConfig((raw) => {
      raw.track = { mode: 'list', repos: ['z'] };
    });
    const tmpPathUsed = writeSpy.mock.calls.map((c) => c[0]).find((p) => typeof p === 'string' && p.includes('.tmp'));
    expect(tmpPathUsed).toBe(`${configPath()}.${process.pid}.tmp`);
    writeSpy.mockRestore();
  });
});

describe('readGlobalConfig 对非普通对象的解析结果返回空对象', () => {
  it('顶层是 null', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), 'null');
    expect(readGlobalConfig()).toEqual({});
  });

  it('顶层是数组', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), '[1,2]');
    expect(readGlobalConfig()).toEqual({});
  });
});

function repoWithOrigin(url: string): string {
  const repo = initRepo();
  sh(repo, ['remote', 'add', 'origin', url]);
  return repo;
}

describe('trackRepo / isRepoTracked / untrackRepo', () => {
  it('trackRepo 在 all 模式下从黑名单移除，switched 永远为 false', () => {
    const repo = repoWithOrigin('git@gitlab.example.com:group/a.git');
    // 先加入黑名单
    untrackRepo(repo);
    expect(readGlobalConfig().track).toEqual({ mode: 'all', repos: [repoId(repo)] });

    // track 从黑名单移除
    const first = trackRepo(repo);
    expect(first.switched).toBe(false);
    expect(readGlobalConfig().track).toEqual({ mode: 'all', repos: [] });

    // 再次 track 已经不在黑名单的仓库，repos 保持为空
    const second = trackRepo(repo);
    expect(second.switched).toBe(false);
    expect(readGlobalConfig().track).toEqual({ mode: 'all', repos: [] });
  });

  it('isRepoTracked：all 模式下，黑名单外为 true、黑名单内为 false', () => {
    const tracked = repoWithOrigin('git@gitlab.example.com:group/tracked.git');
    const other = repoWithOrigin('git@gitlab.example.com:group/other.git');
    // 默认 all 模式，repos 为空，所有仓库都跟踪
    expect(isRepoTracked(tracked)).toBe(true);
    expect(isRepoTracked(other)).toBe(true);

    // untrack 添加到黑名单
    untrackRepo(tracked);
    expect(isRepoTracked(tracked)).toBe(false);
    expect(isRepoTracked(other)).toBe(true);
  });

  it('untrackRepo 添加到黑名单；setTrackAll 清空黑名单后所有仓库都为 true', () => {
    const tracked = repoWithOrigin('git@gitlab.example.com:group/tracked.git');
    const other = repoWithOrigin('git@gitlab.example.com:group/other.git');

    // untrack 添加到黑名单
    const result = untrackRepo(tracked);
    expect(result.removed).toBe(true);
    expect(isRepoTracked(tracked)).toBe(false);
    expect(isRepoTracked(other)).toBe(true);

    // 再次 untrack 已在黑名单的仓库
    const again = untrackRepo(tracked);
    expect(again.removed).toBe(false);

    // setTrackAll 清空黑名单
    setTrackAll();
    expect(isRepoTracked(tracked)).toBe(true);
    expect(isRepoTracked(other)).toBe(true);
  });

  it('describeTrack 描述当前模式与黑名单', () => {
    expect(describeTrack()).toContain('所有仓库');
    const repo = repoWithOrigin('git@gitlab.example.com:group/described.git');
    const { id } = untrackRepo(repo); // untrack 添加到黑名单
    expect(describeTrack()).toContain(id);
  });

  it('全局配置损坏时，trackRepo 抛错且不覆盖原文件（对应 aicode track / init --local 场景）', () => {
    const repo = repoWithOrigin('git@gitlab.example.com:group/corrupt.git');
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    const corrupt = '{ "reporter": { "type": "mysql", "options": { "password": "secret" } }, }';
    fs.writeFileSync(configPath(), corrupt);
    expect(() => trackRepo(repo)).toThrow('解析失败');
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(corrupt);
  });

  it('removeFromTrackList：all 模式下添加到黑名单（init --local --uninstall）', () => {
    const repo = repoWithOrigin('git@gitlab.example.com:group/to-remove.git');
    const id = repoId(repo);

    // 第一次：添加到黑名单
    removeFromTrackList(repo);
    expect(fs.existsSync(configPath())).toBe(true);
    expect(readGlobalConfig().track).toEqual({ mode: 'all', repos: [id] });

    // 已经在黑名单中，再次调用应该幂等（不重复添加）
    const before = fs.readFileSync(configPath(), 'utf8');
    removeFromTrackList(repo);
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(before);
    expect(readGlobalConfig().track).toEqual({ mode: 'all', repos: [id] });
  });

  it('addToTrackList/removeFromTrackList 只增删名单、不改变 mode', () => {
    const repo = repoWithOrigin('git@gitlab.example.com:group/list-only.git');
    const id = repoId(repo);

    // all 模式下：removeFromTrackList 添加到黑名单
    removeFromTrackList(repo);
    expect(readGlobalConfig().track).toEqual({ mode: 'all', repos: [id] });

    // all 模式下：addToTrackList 从黑名单移除
    addToTrackList(repo);
    expect(readGlobalConfig().track).toEqual({ mode: 'all', repos: [] });
  });
});

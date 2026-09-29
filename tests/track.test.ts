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
  it('trackRepo 从 all 切到 list，switched 为 true；再次 track 同一仓库不重复、switched 为 false', () => {
    const repo = repoWithOrigin('git@gitlab.example.com:group/a.git');
    const first = trackRepo(repo);
    expect(first.switched).toBe(true);
    expect(readGlobalConfig().track).toEqual({ mode: 'list', repos: [first.id] });

    const second = trackRepo(repo);
    expect(second.switched).toBe(false);
    expect(readGlobalConfig().track).toEqual({ mode: 'list', repos: [first.id] });
  });

  it('isRepoTracked：all 模式下任意仓库为 true；list 模式下名单内为 true、名单外为 false', () => {
    const tracked = repoWithOrigin('git@gitlab.example.com:group/tracked.git');
    const other = repoWithOrigin('git@gitlab.example.com:group/other.git');
    expect(isRepoTracked(tracked)).toBe(true);
    expect(isRepoTracked(other)).toBe(true);

    trackRepo(tracked);
    expect(isRepoTracked(tracked)).toBe(true);
    expect(isRepoTracked(other)).toBe(false);
  });

  it('untrackRepo 移出名单；setTrackAll 后名单外仓库也为 true', () => {
    const tracked = repoWithOrigin('git@gitlab.example.com:group/tracked.git');
    const other = repoWithOrigin('git@gitlab.example.com:group/other.git');
    trackRepo(tracked);
    expect(isRepoTracked(other)).toBe(false);

    const result = untrackRepo(tracked);
    expect(result.removed).toBe(true);
    expect(isRepoTracked(tracked)).toBe(false);

    const again = untrackRepo(tracked);
    expect(again.removed).toBe(false);

    setTrackAll();
    expect(isRepoTracked(other)).toBe(true);
    expect(isRepoTracked(tracked)).toBe(true);
  });

  it('describeTrack 描述当前模式与名单', () => {
    expect(describeTrack()).toContain('所有仓库');
    const repo = repoWithOrigin('git@gitlab.example.com:group/described.git');
    const { id } = trackRepo(repo);
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

  it('removeFromTrackList：仓库不在名单中时不写入，不创建 ~/.aicode/config.json（对应 init --local --uninstall 场景）', () => {
    const repo = repoWithOrigin('git@gitlab.example.com:group/never-tracked.git');
    removeFromTrackList(repo);
    expect(fs.existsSync(configPath())).toBe(false);

    trackRepo(repo);
    untrackRepo(repo);
    const before = fs.readFileSync(configPath(), 'utf8');
    removeFromTrackList(repo); // 已经不在名单中，再次调用不应改动文件
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(before);
  });

  it('addToTrackList/removeFromTrackList 只增删名单、不改变 mode', () => {
    const repo = repoWithOrigin('git@gitlab.example.com:group/list-only.git');
    addToTrackList(repo);
    expect(readGlobalConfig().track).toEqual({ mode: 'all', repos: [repoId(repo)] });
    removeFromTrackList(repo);
    expect(readGlobalConfig().track).toEqual({ mode: 'all', repos: [] });
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readGlobalConfig, updateGlobalConfig } from '../src/config.js';
import { configPath } from '../src/paths.js';
import {
  describeTrack, isRepoTracked, setTrackAll, trackRepo, untrackRepo,
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
});

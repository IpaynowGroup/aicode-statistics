import { readGlobalConfig, updateGlobalConfig, type TrackConfig } from './config.js';
import { repoId } from './git.js';

const DEFAULT_TRACK: TrackConfig = { mode: 'all', repos: [] };

/** 与 config.ts 中 readJson 的校验一致：字段类型错误时退回默认值（全部统计） */
function getTrack(raw: Record<string, unknown>): TrackConfig {
  const t = raw.track as Partial<TrackConfig> | undefined;
  if (t && (t.mode === 'all' || t.mode === 'list') && Array.isArray(t.repos) && t.repos.every((r) => typeof r === 'string')) {
    return { mode: t.mode, repos: [...t.repos] };
  }
  return { ...DEFAULT_TRACK };
}

export function isRepoTracked(root: string): boolean {
  const track = getTrack(readGlobalConfig());
  return track.mode === 'all' || track.repos.includes(repoId(root));
}

/** 把仓库加入统计名单并切到 list 模式；switched 表示本次从 all 切到 list */
export function trackRepo(root: string): { id: string; switched: boolean } {
  const id = repoId(root);
  let switched = false;
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    switched = track.mode === 'all';
    if (!track.repos.includes(id)) track.repos.push(id);
    raw.track = { mode: 'list', repos: track.repos };
  });
  return { id, switched };
}

/** 把仓库移出统计名单，不改变 mode */
export function untrackRepo(root: string): { id: string; removed: boolean } {
  const id = repoId(root);
  let removed = false;
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    const idx = track.repos.indexOf(id);
    if (idx !== -1) {
      track.repos.splice(idx, 1);
      removed = true;
    }
    raw.track = track;
  });
  return { id, removed };
}

/** 只增，不改变 mode；供 init --local 安装时使用 */
export function addToTrackList(root: string): void {
  const id = repoId(root);
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    if (!track.repos.includes(id)) track.repos.push(id);
    raw.track = track;
  });
}

/** 只删，不改变 mode；供 init --local 卸载时使用 */
export function removeFromTrackList(root: string): void {
  const id = repoId(root);
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    const idx = track.repos.indexOf(id);
    if (idx !== -1) track.repos.splice(idx, 1);
    raw.track = track;
  });
}

export function setTrackAll(): void {
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    raw.track = { mode: 'all', repos: track.repos };
  });
}

export function describeTrack(): string {
  const track = getTrack(readGlobalConfig());
  if (track.mode === 'all') return '当前统计所有仓库';
  const list = track.repos.length ? track.repos.map((r) => `  - ${r}`).join('\n') : '  (空)';
  return `当前只统计名单中的仓库：\n${list}`;
}

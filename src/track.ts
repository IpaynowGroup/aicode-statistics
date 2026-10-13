import { defaultTrack, isTrackConfig, readGlobalConfig, updateGlobalConfig, type TrackConfig } from './config.js';
import { repoId } from './git.js';

/** 与 config.ts 中 readJson 的校验一致：字段类型错误时退回默认值（全部统计） */
function getTrack(raw: Record<string, unknown>): TrackConfig {
  const t = raw.track;
  return isTrackConfig(t) ? { mode: t.mode, repos: [...t.repos] } : defaultTrack();
}

export function isRepoTracked(root: string): boolean {
  const track = getTrack(readGlobalConfig());
  const id = repoId(root);
  // all 模式：repos 是黑名单，不在列表中才跟踪
  if (track.mode === 'all') return !track.repos.includes(id);
  // list 模式：repos 是白名单，在列表中才跟踪
  return track.repos.includes(id);
}

/**
 * 把仓库加入统计名单
 * - all 模式：从黑名单移除（重新跟踪）
 * - 其他模式：添加到白名单并切到 list 模式
 * switched 表示本次从 all 切到 list
 */
export function trackRepo(root: string): { id: string; switched: boolean } {
  const id = repoId(root);
  let switched = false;
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    if (track.mode === 'all') {
      // all 模式：从黑名单移除
      const idx = track.repos.indexOf(id);
      if (idx !== -1) track.repos.splice(idx, 1);
      raw.track = track;
    } else {
      // list 模式：添加到白名单并切到 list
      switched = track.mode !== 'list';
      if (!track.repos.includes(id)) track.repos.push(id);
      raw.track = { mode: 'list', repos: track.repos };
    }
  });
  return { id, switched };
}

/**
 * 把仓库移出统计名单
 * - all 模式：添加到黑名单（不跟踪）
 * - list 模式：从白名单移除
 * removed 表示本次成功添加/移除
 */
export function untrackRepo(root: string): { id: string; removed: boolean } {
  const id = repoId(root);
  let removed = false;
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    if (track.mode === 'all') {
      // all 模式：添加到黑名单
      if (!track.repos.includes(id)) {
        track.repos.push(id);
        removed = true;
      }
    } else {
      // list 模式：从白名单移除
      const idx = track.repos.indexOf(id);
      if (idx !== -1) {
        track.repos.splice(idx, 1);
        removed = true;
      }
    }
    raw.track = track;
  });
  return { id, removed };
}

/** 供 init --local 安装时使用：all 模式下从黑名单移除（确保该仓库被统计），list 模式下添加到白名单 */
export function addToTrackList(root: string): void {
  const id = repoId(root);
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    if (track.mode === 'all') {
      // all 模式：从黑名单移除
      const idx = track.repos.indexOf(id);
      if (idx !== -1) track.repos.splice(idx, 1);
    } else {
      // list 模式：添加到白名单
      if (!track.repos.includes(id)) track.repos.push(id);
    }
    raw.track = track;
  });
}

/** 供 init --local 卸载时使用：all 模式下添加到黑名单，list 模式下从白名单移除 */
export function removeFromTrackList(root: string): void {
  const id = repoId(root);
  updateGlobalConfig((raw) => {
    const track = getTrack(raw);
    if (track.mode === 'all') {
      // all 模式：添加到黑名单
      if (!track.repos.includes(id)) track.repos.push(id);
    } else {
      // list 模式：从白名单移除
      const idx = track.repos.indexOf(id);
      if (idx !== -1) track.repos.splice(idx, 1);
    }
    raw.track = track;
  });
}

export function setTrackAll(): void {
  updateGlobalConfig((raw) => {
    raw.track = { mode: 'all', repos: [] }; // 清空黑名单
  });
}

export function describeTrack(): string {
  const track = getTrack(readGlobalConfig());
  if (track.mode === 'all') {
    if (track.repos.length === 0) {
      return '当前统计所有仓库';
    }
    const list = track.repos.map((r) => `  - ${r}`).join('\n');
    return `当前统计所有仓库，但以下仓库已加入黑名单（不跟踪）：\n${list}`;
  }
  const list = track.repos.length ? track.repos.map((r) => `  - ${r}`).join('\n') : '  (空)';
  return `当前只统计名单中的仓库：\n${list}`;
}

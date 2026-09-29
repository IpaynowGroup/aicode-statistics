import fs from 'node:fs';
import path from 'node:path';
import type { CommitStats, FileStat } from './analyzer.js';
import { eventsPath, reportedPath } from './paths.js';

export interface CommitEvent {
  event_id: string;
  repo: string;
  branch: string;
  commit_sha: string;
  parent_sha: string | null;
  commit_message: string;
  committed_at: string;
  amend: boolean;
  owner: { name: string; email: string };
  module: string;
  stats: CommitStats;
  files: FileStat[];
  client_version: string;
}

function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // 跳过损坏行
    }
  }
  return out;
}

function appendJsonl(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

export function appendEvent(e: CommitEvent): void {
  appendJsonl(eventsPath(), e);
}

export function hasEvent(eventId: string): boolean {
  return readJsonl<CommitEvent>(eventsPath()).some((e) => e.event_id === eventId);
}

export function readUnreported(limit: number): CommitEvent[] {
  const reported = new Set(readJsonl<{ event_id: string }>(reportedPath()).map((r) => r.event_id));
  return readJsonl<CommitEvent>(eventsPath()).filter((e) => !reported.has(e.event_id)).slice(0, limit);
}

export function markReported(eventId: string): void {
  appendJsonl(reportedPath(), { event_id: eventId });
}

export function countUnreported(): number {
  const reported = new Set(readJsonl<{ event_id: string }>(reportedPath()).map((r) => r.event_id));
  return readJsonl<CommitEvent>(eventsPath()).filter((e) => !reported.has(e.event_id)).length;
}

// pw-monitor source adapter — reads monitor state files and watches for changes
import { readFileSync, existsSync, watch } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface SourceAdapter {
  name: string;
  readSnapshot(sessionName: string): any;
  subscribe(sessionName: string, emit: (event: any) => void): () => void;
}

function sessionDir(sessionName: string): string {
  return join(homedir(), '.playwright-state', 'sessions', sessionName);
}

function readJsonSafe(path: string): any {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function buildSnapshot(sessionName: string): any {
  const dir = sessionDir(sessionName);
  const tabs = readJsonSafe(join(dir, 'monitor-tabs.json'));
  const session = readJsonSafe(join(dir, 'session.json'));
  const pendingActions = readJsonSafe(join(dir, 'pending-actions.json'));

  return {
    session: session ? {
      name: session.name,
      id: session.id,
      pid: session.pid,
      cdpEndpoint: session.cdpEndpoint,
      startedAt: session.startedAt,
    } : null,
    tabs: tabs?.tabs || [],
    activeTabId: tabs?.activeTabId ?? null,
    sidecarPid: tabs?.sidecarPid ?? null,
    sidecarAlive: tabs?.sidecarPid ? isAlive(tabs.sidecarPid) : false,
    pendingActions: pendingActions?.pending || [],
    timestamp: new Date().toISOString(),
  };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export const pwMonitorAdapter: SourceAdapter = {
  name: 'pw-monitor',

  readSnapshot(sessionName: string): any {
    return buildSnapshot(sessionName);
  },

  subscribe(sessionName: string, emit: (event: any) => void): () => void {
    const dir = sessionDir(sessionName);
    if (!existsSync(dir)) return () => {};

    let prevJson = '';
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const watcher = watch(dir, { recursive: false }, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const snapshot = buildSnapshot(sessionName);
        const json = JSON.stringify(snapshot);
        if (json !== prevJson) {
          prevJson = json;
          emit(snapshot);
        }
      }, 30);
    });

    return () => { watcher.close(); };
  },
};

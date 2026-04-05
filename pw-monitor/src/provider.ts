// pw-monitor provider for the pw-monitor/v1 protocol
//
// Loaded by pw-ws-server at runtime via extension.provides.protocols in
// larry.json. Reads state written by pw-monitor's sidecar (monitor-tabs.json,
// session.json, pending-actions.json) and exposes it as a TransportProvider.
//
// pw-monitor owns this protocol — pw-ws-server is transport only.

import { readFileSync, existsSync, watch } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * TransportProvider interface — matches the shape pw-ws-server's provider
 * loader expects. Kept intentionally minimal so transports other than
 * WebSocket (IPC, file, etc.) can serve the same provider later.
 */
export interface TransportProvider {
  channel: string;
  readSnapshot(sessionName: string): unknown;
  subscribe(sessionName: string, emit: (snapshot: unknown) => void): () => void;
}

function sessionDir(sessionName: string): string {
  return join(homedir(), '.playwright-state', 'sessions', sessionName);
}

function readJsonSafe(path: string): any {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
    browserVisible: tabs?.browserVisible ?? true,
    browserFocused: tabs?.browserFocused ?? true,
    sidecarPid: tabs?.sidecarPid ?? null,
    sidecarAlive: tabs?.sidecarPid ? isAlive(tabs.sidecarPid) : false,
    pendingActions: pendingActions?.pending || [],
    timestamp: new Date().toISOString(),
  };
}

const provider: TransportProvider = {
  channel: 'pw-monitor/v1',

  readSnapshot(sessionName: string): unknown {
    return buildSnapshot(sessionName);
  },

  subscribe(sessionName: string, emit: (snapshot: unknown) => void): () => void {
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

export default provider;

// monitor-ws-client.ts — thin wrapper that loads pw-monitor's client module
// from the toybox at runtime. pw-user-action itself does not know about
// WebSocket, pw-ws-server, or monitor-tabs.json — it just calls
// subscribeMonitor and reacts to state updates.
//
// The only coupling is "pw-monitor is a rary dependency" (declared in
// larry.json's extension.dependencies), which rary resolves before
// activation. At load time we dynamic-import the provider's client entry
// from ~/.playwright-state/toybox/pw-monitor/dist/client.js.

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { pathToFileURL } from 'url';

export interface MonitorState {
  session?: { name?: string; pid?: number | null; cdpEndpoint?: string | null } | null;
  tabs?: Array<{ tabId: number; cdpTargetId: string; url: string; title?: string }>;
  activeTabId?: number | null;
  browserVisible?: boolean;
  browserFocused?: boolean;
  sidecarPid?: number | null;
  sidecarAlive?: boolean;
  pendingActions?: unknown[];
  timestamp?: string;
}

export interface MonitorSubscription {
  initial: MonitorState;
  close: () => void;
}

type PwMonitorClient = {
  subscribeMonitor: (
    sessionName: string,
    onUpdate: (state: MonitorState) => void,
    opts?: { connectTimeoutMs?: number; snapshotTimeoutMs?: number },
  ) => Promise<MonitorSubscription>;
};

let cachedClient: PwMonitorClient | null = null;

async function loadPwMonitorClient(): Promise<PwMonitorClient> {
  if (cachedClient) return cachedClient;

  const candidates = [
    join(homedir(), '.playwright-state', 'toybox', 'pw-monitor', 'dist', 'client.js'),
    join(homedir(), '.playwright-state', 'toybox', 'pw-monitor', 'src', 'client.ts'),
  ];
  const entry = candidates.find(existsSync);
  if (!entry) {
    throw new Error(
      'pw-monitor client module not found. Ensure pw-monitor is installed in the toybox (check extension.dependencies).',
    );
  }

  const mod = await import(pathToFileURL(entry).href);
  if (typeof mod?.subscribeMonitor !== 'function') {
    throw new Error(`pw-monitor client at ${entry} does not export subscribeMonitor()`);
  }
  cachedClient = mod as PwMonitorClient;
  return cachedClient;
}

export async function subscribeMonitor(
  sessionName: string,
  onUpdate: (state: MonitorState) => void,
): Promise<MonitorSubscription> {
  const client = await loadPwMonitorClient();
  return client.subscribeMonitor(sessionName, onUpdate);
}

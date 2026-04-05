// client.ts — pw-monitor public consumer API
//
// Other extensions (e.g. pw-user-action) use this module to subscribe to
// the pw-monitor/v1 protocol without knowing that the current transport is
// WebSocket + pw-ws-server. pw-monitor owns the wire format, the channel
// name, and the state shape — transport is an implementation detail.
//
// Callers do NOT need to:
//   - read monitor-tabs.json
//   - know about pw-ws-server
//   - manage the WebSocket connection
//
// They DO need to:
//   - ensure pw-monitor is installed and activated in their raryDependencies
//     or extension.dependencies

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
  /** Initial state received right after connecting (via snapshot message) */
  initial: MonitorState;
  /** Close the subscription and the underlying transport connection */
  close: () => void;
}

/** Logical channel name that pw-monitor publishes on */
const CHANNEL = 'pw-monitor/v1';

interface WsMeta {
  pid: number;
  host: string;
  port: number;
  channels?: string[];
}

function wsMetaPath(sessionName: string): string {
  return join(homedir(), '.playwright-state', 'sessions', sessionName, 'ws-server.json');
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readWsMeta(sessionName: string): WsMeta | null {
  const p = wsMetaPath(sessionName);
  if (!existsSync(p)) return null;
  try {
    const meta = JSON.parse(readFileSync(p, 'utf-8'));
    if (!meta?.pid || !meta?.port || !meta?.host) return null;
    if (!isAlive(meta.pid)) return null;
    return meta as WsMeta;
  } catch {
    return null;
  }
}

/**
 * Subscribe to pw-monitor state for the given session.
 *
 * Waits for the transport to report a snapshot (up to 5 seconds) and then
 * returns. Subsequent state changes are delivered to onUpdate. The caller
 * must call subscription.close() when done.
 *
 * Throws if the transport (pw-ws-server) is not reachable within the
 * connect timeout. pw-monitor's launch-hook auto-starts pw-ws-server when
 * both extensions are active, so under normal installs this just works.
 */
export async function subscribeMonitor(
  sessionName: string,
  onUpdate: (state: MonitorState) => void,
  opts: { connectTimeoutMs?: number; snapshotTimeoutMs?: number } = {},
): Promise<MonitorSubscription> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 3000;
  const snapshotTimeoutMs = opts.snapshotTimeoutMs ?? 5000;

  // Wait for transport to appear (launch-hook spawns it in parallel)
  const deadline = Date.now() + connectTimeoutMs;
  let meta: WsMeta | null = null;
  while (Date.now() < deadline) {
    meta = readWsMeta(sessionName);
    if (meta) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!meta) {
    throw new Error(`pw-monitor: transport (pw-ws-server) unavailable for session "${sessionName}"`);
  }

  const url = `ws://${meta.host}:${meta.port}`;
  const ws = new WebSocket(url);

  let snapshotResolve!: (state: MonitorState) => void;
  let snapshotReject!: (err: Error) => void;
  const snapshotPromise = new Promise<MonitorState>((resolve, reject) => {
    snapshotResolve = resolve;
    snapshotReject = reject;
  });

  const snapshotTimer = setTimeout(() => {
    snapshotReject(new Error(`pw-monitor: snapshot not received within ${snapshotTimeoutMs}ms`));
  }, snapshotTimeoutMs);

  ws.addEventListener('message', (event: MessageEvent) => {
    let msg: any;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (msg?.channel && msg.channel !== CHANNEL) return;

    if (msg?.type === 'snapshot' && msg.data) {
      clearTimeout(snapshotTimer);
      snapshotResolve(msg.data as MonitorState);
      onUpdate(msg.data as MonitorState);
    } else if (msg?.type === 'event' && msg.data) {
      onUpdate(msg.data as MonitorState);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const connectTimer = setTimeout(() => reject(new Error('pw-monitor: WebSocket connect timeout')), connectTimeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(connectTimer);
      try {
        ws.send(JSON.stringify({ type: 'subscribe', channel: CHANNEL }));
      } catch (err: any) {
        reject(new Error(`pw-monitor: failed to send subscribe: ${err?.message || String(err)}`));
        return;
      }
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(connectTimer);
      reject(new Error('pw-monitor: WebSocket connect error'));
    }, { once: true });
  });

  const initial = await snapshotPromise;

  return {
    initial,
    close: () => {
      try { ws.close(); } catch {}
    },
  };
}

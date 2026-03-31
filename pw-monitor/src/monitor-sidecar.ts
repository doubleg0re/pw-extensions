#!/usr/bin/env npx tsx
// monitor-sidecar.ts — Background CDP monitor process
// Spawned as a detached child by pw-monitor launch hook.
// Connects to browser via CDP WebSocket and tracks tab lifecycle in real-time.
//
// Usage: monitor-sidecar.ts <cdpEndpoint> <sessionName> <registryPath>
//
// Writes monitor-tabs.json continuously as tabs are created/closed/navigated.
// Also writes sidecar.pid to the session directory for lifecycle tracking.

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
// Uses Node built-in WebSocket (Node 22+), no external dependency needed

const [,, cdpEndpoint, sessionName, registryPath] = process.argv;

if (!cdpEndpoint || !sessionName || !registryPath) {
  process.stderr.write('Usage: monitor-sidecar.ts <cdpEndpoint> <sessionName> <registryPath>\n');
  process.exit(1);
}

// --- Tab state ---

interface TabEntry {
  tabId: number;
  cdpTargetId: string;
  url: string;
  title: string;
  createdAt: string;
  lastSeenAt: string;
}

let nextId = 1;
let activeTabId: number | null = null;
const tabs = new Map<number, TabEntry>();

function findByCdpId(id: string): TabEntry | undefined {
  for (const e of tabs.values()) {
    if (e.cdpTargetId === id) return e;
  }
  return undefined;
}

function persistRegistry(): void {
  const data = {
    nextId,
    tabs: Array.from(tabs.values()),
    activeTabId,
    sidecarPid: process.pid,
  };
  atomicWriteJSON(registryPath, data);
}

function restoreRegistry(): void {
  if (!existsSync(registryPath)) return;
  try {
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8'));
    if (raw.nextId) nextId = raw.nextId;
    if (raw.activeTabId != null) activeTabId = raw.activeTabId;
    if (Array.isArray(raw.tabs)) {
      for (const entry of raw.tabs) {
        tabs.set(entry.tabId, entry);
      }
    }
  } catch {}
}

function atomicWriteJSON(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  try { unlinkSync(filePath); } catch {}
  renameSync(tmp, filePath);
}

// --- CDP WebSocket connection ---

async function connect(): Promise<void> {
  restoreRegistry();

  // Startup timeout — covers /json/version fetch + WebSocket connect
  const startupTimeout = setTimeout(() => {
    process.stderr.write('[monitor-sidecar] startup timeout (10s), exiting\n');
    persistRegistry();
    process.exit(1);
  }, 10000);

  // Get browser WebSocket URL from CDP endpoint
  const port = cdpEndpoint.match(/:(\d+)\//)?.[1];
  if (!port) {
    clearTimeout(startupTimeout);
    process.stderr.write(`Cannot extract port from CDP endpoint: ${cdpEndpoint}\n`);
    process.exit(1);
  }

  // Fetch browser WebSocket debugger URL
  let browserWsUrl: string;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    const info = await res.json() as any;
    browserWsUrl = info.webSocketDebuggerUrl;
    if (!browserWsUrl) throw new Error('No webSocketDebuggerUrl in /json/version');
  } catch (err: any) {
    clearTimeout(startupTimeout);
    process.stderr.write(`Failed to get browser WS URL: ${err.message}\n`);
    process.exit(1);
  }

  const ws = new WebSocket(browserWsUrl);
  let msgId = 1;

  function send(method: string, params?: any): void {
    ws.send(JSON.stringify({ id: msgId++, method, params }));
  }

  ws.addEventListener('open', () => {
    clearTimeout(startupTimeout);
    process.stderr.write(`[monitor-sidecar] connected to ${browserWsUrl}\n`);
    // Enable target discovery
    send('Target.setDiscoverTargets', { discover: true });

    // Poll active tab via CDP /json (first page target = active, best-effort)
    // Overlap guard: skip if previous poll still in-flight
    let polling = false;
    setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: controller.signal });
        clearTimeout(timeout);
        const targets = (await res.json() as any[]).filter((t: any) => t.type === 'page');
        if (targets.length > 0) {
          const topEntry = findByCdpId(targets[0].id);
          if (topEntry && activeTabId !== topEntry.tabId) {
            activeTabId = topEntry.tabId;
            persistRegistry();
          }
        }
      } catch {}
      polling = false;
    }, 500);
  });

  ws.addEventListener('message', (event: MessageEvent) => {
    try {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      handleCdpEvent(msg);
    } catch {}
  });

  ws.addEventListener('close', () => {
    process.stderr.write('[monitor-sidecar] CDP connection closed, exiting\n');
    persistRegistry();
    process.exit(0);
  });

  ws.addEventListener('error', () => {
    process.stderr.write(`[monitor-sidecar] CDP WebSocket error\n`);
  });
}

function handleCdpEvent(msg: any): void {
  const { method, params } = msg;
  if (!method || !params) return;

  const now = new Date().toISOString();

  switch (method) {
    case 'Target.targetCreated': {
      const { targetInfo } = params;
      if (targetInfo.type !== 'page') break;
      // Check if this target already exists (reconnect/discovery duplicate)
      const existing = findByCdpId(targetInfo.targetId);
      if (existing) {
        existing.url = targetInfo.url || existing.url;
        existing.title = targetInfo.title || existing.title;
        existing.lastSeenAt = now;
        persistRegistry();
        break;
      }
      const entry: TabEntry = {
        tabId: nextId++,
        cdpTargetId: targetInfo.targetId,
        url: targetInfo.url || 'about:blank',
        title: targetInfo.title || '',
        createdAt: now,
        lastSeenAt: now,
      };
      tabs.set(entry.tabId, entry);
      persistRegistry();
      process.stderr.write(`[monitor-sidecar] tab:created tabId=${entry.tabId} url=${entry.url}\n`);
      break;
    }

    case 'Target.targetDestroyed': {
      const { targetId } = params;
      const entry = findByCdpId(targetId);
      if (entry) {
        tabs.delete(entry.tabId);
        if (activeTabId === entry.tabId) activeTabId = null;
        persistRegistry();
        process.stderr.write(`[monitor-sidecar] tab:closed tabId=${entry.tabId}\n`);
      }
      break;
    }

    case 'Target.targetInfoChanged': {
      const { targetInfo } = params;
      if (targetInfo.type !== 'page') break;
      const entry = findByCdpId(targetInfo.targetId);
      if (!entry) break;

      const urlChanged = entry.url !== targetInfo.url;
      entry.url = targetInfo.url || entry.url;
      entry.title = targetInfo.title || entry.title;
      entry.lastSeenAt = now;

      if (urlChanged) {
        process.stderr.write(`[monitor-sidecar] tab:navigated tabId=${entry.tabId} url=${entry.url}\n`);
      }
      persistRegistry();
      break;
    }
  }
}

// --- Graceful shutdown ---

process.on('SIGTERM', () => {
  process.stderr.write('[monitor-sidecar] received SIGTERM, shutting down\n');
  persistRegistry();
  process.exit(0);
});

process.on('SIGINT', () => {
  process.stderr.write('[monitor-sidecar] received SIGINT, shutting down\n');
  persistRegistry();
  process.exit(0);
});

// --- Start ---

connect().catch(err => {
  process.stderr.write(`[monitor-sidecar] fatal: ${err.message}\n`);
  process.exit(1);
});

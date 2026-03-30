#!/usr/bin/env npx tsx
// gui/server.ts — Lightweight HTTP server for pw-monitor dashboard
// No external dependencies — uses Node built-in http module.
// Serves dashboard HTML, JSON API, and SSE stream via fs.watch.
//
// Usage: server.ts <sessionName> [--port=3100]

import { createServer, type ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, watch } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const args = process.argv.slice(2);
const sessionName = args.find(a => !a.startsWith('--'));
const portFlag = args.find(a => a.startsWith('--port='));
const port = portFlag ? parseInt(portFlag.slice('--port='.length), 10) : 3100;

if (!sessionName) {
  process.stderr.write('Usage: server.ts <sessionName> [--port=3100]\n');
  process.exit(1);
}

const sessionDir = join(homedir(), '.playwright-state', 'sessions', sessionName);
const registryPath = join(sessionDir, 'monitor-tabs.json');
const sessionJsonPath = join(sessionDir, 'session.json');
const pendingActionsPath = join(sessionDir, 'pending-actions.json');
const dashboardPath = join(import.meta.dirname || __dirname, 'dashboard.html');

function readJsonSafe(path: string): any {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function buildState(): any {
  const tabs = readJsonSafe(registryPath);
  const session = readJsonSafe(sessionJsonPath);
  const pendingActions = readJsonSafe(pendingActionsPath);
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

// --- SSE: push state to connected clients on file change ---

const sseClients = new Set<ServerResponse>();

// Watch session directory for any file changes
let watchDebounce: ReturnType<typeof setTimeout> | null = null;

function startWatcher(): void {
  if (!existsSync(sessionDir)) return;
  try {
    watch(sessionDir, { recursive: false }, () => {
      // Debounce rapid writes (sidecar writes frequently)
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        const state = buildState();
        const data = `data: ${JSON.stringify(state)}\n\n`;
        for (const client of sseClients) {
          try { client.write(data); } catch { sseClients.delete(client); }
        }
      }, 100);
    });
  } catch {}
}

// --- HTTP server ---

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);

  res.setHeader('Access-Control-Allow-Origin', '*');

  switch (url.pathname) {
    case '/':
    case '/dashboard': {
      if (!existsSync(dashboardPath)) {
        res.writeHead(404);
        res.end('dashboard.html not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(dashboardPath, 'utf-8'));
      return;
    }

    case '/api/state': {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildState()));
      return;
    }

    case '/api/events': {
      // SSE endpoint
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // Send initial state immediately
      res.write(`data: ${JSON.stringify(buildState())}\n\n`);

      sseClients.add(res);
      req.on('close', () => { sseClients.delete(res); });
      return;
    }

    default:
      res.writeHead(404);
      res.end('Not found');
  }
});

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

server.listen(port, () => {
  // Write GUI PID for close hook cleanup
  const guiPidPath = join(sessionDir, 'gui.pid');
  writeFileSync(guiPidPath, String(process.pid));

  // Start file watcher for SSE
  startWatcher();

  process.stderr.write(`[pw-monitor-gui] dashboard at http://localhost:${port}\n`);
  process.stderr.write(`[pw-monitor-gui] session: ${sessionName} (SSE enabled)\n`);

  // Auto-exit when session is closed
  const sessionCheck = setInterval(() => {
    const session = readJsonSafe(sessionJsonPath);
    if (!session) {
      process.stderr.write(`[pw-monitor-gui] session gone, shutting down\n`);
      clearInterval(sessionCheck);
      server.close();
      process.exit(0);
    }
    if (session.pid && !isAlive(session.pid)) {
      process.stderr.write(`[pw-monitor-gui] session process dead, shutting down\n`);
      clearInterval(sessionCheck);
      server.close();
      process.exit(0);
    }
  }, 3000);
});

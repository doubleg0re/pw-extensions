#!/usr/bin/env npx tsx
// server.ts — Generic provider-hosting WebSocket server
//
// pw-ws-server is transport only. It does not define domain protocols.
// Instead, it discovers providers from active rary extensions via their
// larry.json extension.provides.protocols declarations, dynamically
// imports each provider, and serves them on channels over WebSocket.
//
// Wire protocol:
//   Server → client:
//     { type: "snapshot", channel, data, timestamp }   - initial state on subscribe
//     { type: "event",    channel, data, timestamp }   - state updates
//     { type: "pong",     message?, timestamp }
//     { type: "error",    error, details? }
//   Client → server:
//     { type: "subscribe",   channel }                 - get snapshot + events
//     { type: "unsubscribe", channel }
//     { type: "list" }                                 - list available channels
//     { type: "ping",  message? }
//
// Usage: server.ts <sessionName> [--port=47831] [--host=127.0.0.1]

import { WebSocketServer, WebSocket } from 'ws';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadProviders, type LoadedProvider } from './provider-loader.js';

// --- CLI args ---

const args = process.argv.slice(2);
const sessionName = args.find(a => !a.startsWith('--'));
const portFlag = args.find(a => a.startsWith('--port='));
const hostFlag = args.find(a => a.startsWith('--host='));
const port = portFlag ? parseInt(portFlag.slice('--port='.length), 10) : 47831;
const host = hostFlag ? hostFlag.slice('--host='.length) : '127.0.0.1';

if (!sessionName) {
  process.stderr.write('Usage: server.ts <sessionName> [--port=47831] [--host=127.0.0.1]\n');
  process.exit(1);
}

const sessionDir = join(homedir(), '.playwright-state', 'sessions', sessionName);
const metadataPath = join(sessionDir, 'ws-server.json');

// Per-client subscription state
interface ClientState {
  subscriptions: Set<string>;
  unsubscribeFns: Map<string, () => void>;
}

const clientStates = new WeakMap<WebSocket, ClientState>();

async function main(): Promise<void> {
  // Load providers from active extensions
  const { providers, warnings } = await loadProviders('ws');
  for (const w of warnings) process.stderr.write(`[pw-ws-server] ${w}\n`);
  process.stderr.write(`[pw-ws-server] loaded ${providers.size} provider(s): ${[...providers.keys()].join(', ') || '(none)'}\n`);

  const wss = new WebSocketServer({ port, host });

  wss.on('listening', () => {
    const metadata = {
      pid: process.pid,
      session: sessionName,
      host,
      port,
      channels: [...providers.keys()],
      startedAt: new Date().toISOString(),
    };
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    process.stderr.write(`[pw-ws-server] listening on ws://${host}:${port}\n`);
  });

  wss.on('connection', (ws: WebSocket) => {
    clientStates.set(ws, { subscriptions: new Set(), unsubscribeFns: new Map() });

    ws.on('message', async (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        safeSend(ws, { type: 'error', error: 'Invalid JSON' });
        return;
      }
      try {
        await handleMessage(ws, msg, providers);
      } catch (err: any) {
        safeSend(ws, { type: 'error', error: `Handler error: ${err?.message || String(err)}` });
      }
    });

    ws.on('close', () => {
      const state = clientStates.get(ws);
      if (state) {
        for (const unsub of state.unsubscribeFns.values()) {
          try { unsub(); } catch {}
        }
        state.unsubscribeFns.clear();
        state.subscriptions.clear();
      }
      clientStates.delete(ws);
    });
  });

  // Session liveness check
  const sessionCheck = setInterval(() => {
    const sessionJsonPath = join(sessionDir, 'session.json');
    if (!existsSync(sessionJsonPath)) {
      process.stderr.write('[pw-ws-server] session gone, shutting down\n');
      shutdown();
      return;
    }
    try {
      const session = JSON.parse(readFileSync(sessionJsonPath, 'utf-8'));
      if (session.pid) process.kill(session.pid, 0);
    } catch {
      process.stderr.write('[pw-ws-server] session process dead, shutting down\n');
      shutdown();
    }
  }, 3000);

  function shutdown(): void {
    clearInterval(sessionCheck);
    wss.close();
    try { unlinkSync(metadataPath); } catch {}
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  wss.on('error', (err: Error) => {
    if ((err as any).code === 'EADDRINUSE') {
      process.stderr.write(`[pw-ws-server] port ${port} already in use\n`);
      process.exit(1);
    }
  });
}

async function handleMessage(
  ws: WebSocket,
  msg: any,
  providers: Map<string, LoadedProvider>,
): Promise<void> {
  const msgType = msg.type;
  if (!msgType) {
    safeSend(ws, { type: 'error', error: 'Message must have a "type" field' });
    return;
  }

  switch (msgType) {
    case 'ping':
      safeSend(ws, { type: 'pong', message: msg.message, timestamp: new Date().toISOString() });
      return;

    case 'list':
      safeSend(ws, { type: 'list', channels: [...providers.keys()] });
      return;

    case 'subscribe': {
      const channel: string = msg.channel;
      if (typeof channel !== 'string' || !channel) {
        safeSend(ws, { type: 'error', error: 'subscribe: "channel" field is required' });
        return;
      }
      const provider = providers.get(channel);
      if (!provider) {
        safeSend(ws, { type: 'error', error: `Unknown channel: "${channel}"`, details: { available: [...providers.keys()] } });
        return;
      }
      const state = clientStates.get(ws)!;
      if (state.subscriptions.has(channel)) return; // idempotent
      state.subscriptions.add(channel);

      // Send initial snapshot
      try {
        const snap = provider.readSnapshot(sessionName!);
        safeSend(ws, {
          type: 'snapshot',
          channel,
          data: snap,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        safeSend(ws, { type: 'error', error: `readSnapshot failed for "${channel}": ${err?.message || String(err)}` });
      }

      // Start subscription
      const unsub = provider.subscribe(sessionName!, (snap: unknown) => {
        safeSend(ws, {
          type: 'event',
          channel,
          data: snap,
          timestamp: new Date().toISOString(),
        });
      });
      state.unsubscribeFns.set(channel, unsub);
      return;
    }

    case 'unsubscribe': {
      const channel: string = msg.channel;
      if (typeof channel !== 'string' || !channel) {
        safeSend(ws, { type: 'error', error: 'unsubscribe: "channel" field is required' });
        return;
      }
      const state = clientStates.get(ws)!;
      const unsub = state.unsubscribeFns.get(channel);
      if (unsub) {
        try { unsub(); } catch {}
      }
      state.unsubscribeFns.delete(channel);
      state.subscriptions.delete(channel);
      return;
    }

    default:
      safeSend(ws, { type: 'error', error: `Unknown message type: "${msgType}"` });
  }
}

function safeSend(ws: WebSocket, data: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(typeof data === 'string' ? data : JSON.stringify(data));
  } catch {}
}

main().catch(err => {
  process.stderr.write(`[pw-ws-server] fatal: ${err?.message || String(err)}\n`);
  process.exit(1);
});

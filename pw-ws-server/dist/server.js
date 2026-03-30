#!/usr/bin/env npx tsx
// server.ts — Generic protocol-driven WebSocket server
// Wraps Node ws package. Protocols are JSON definitions, handlers are scripts.
//
// Usage: server.ts <sessionName> [--protocol=monitor] [--port=47831] [--host=127.0.0.1]
import { WebSocketServer, WebSocket } from 'ws';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveProtocolPath, loadProtocol, validateSchema, } from './protocol-loader.js';
// --- CLI args ---
const args = process.argv.slice(2);
const sessionName = args.find(a => !a.startsWith('--'));
const portFlag = args.find(a => a.startsWith('--port='));
const hostFlag = args.find(a => a.startsWith('--host='));
const protocolFlag = args.find(a => a.startsWith('--protocol='));
const port = portFlag ? parseInt(portFlag.slice('--port='.length), 10) : 47831;
const host = hostFlag ? hostFlag.slice('--host='.length) : '127.0.0.1';
const protocolName = protocolFlag ? protocolFlag.slice('--protocol='.length) : 'monitor';
if (!sessionName) {
    process.stderr.write('Usage: server.ts <sessionName> [--protocol=monitor] [--port=47831] [--host=127.0.0.1]\n');
    process.exit(1);
}
const sessionDir = join(homedir(), '.playwright-state', 'sessions', sessionName);
const metadataPath = join(sessionDir, 'ws-server.json');
// --- Source adapters registry ---
const sourceAdapters = {};
async function loadSourceAdapter(name) {
    if (sourceAdapters[name])
        return sourceAdapters[name];
    const mod = await import(`./sources/${name}.js`);
    const adapter = mod[`${name.replace(/-/g, '')}Adapter`] || mod.default || mod;
    sourceAdapters[name] = adapter;
    return adapter;
}
// --- Main ---
async function main() {
    // Load protocol
    const protocolPath = resolveProtocolPath(protocolName);
    const protocol = await loadProtocol(protocolPath);
    process.stderr.write(`[pw-ws-server] protocol: ${protocol.def.name} v${protocol.def.version || '0'}\n`);
    // Load source adapter if specified
    let source = null;
    let unsubscribe = null;
    if (protocol.def.source?.adapter) {
        source = await loadSourceAdapter(protocol.def.source.adapter);
        process.stderr.write(`[pw-ws-server] source: ${source.name}\n`);
    }
    // --- WebSocket server ---
    const wss = new WebSocketServer({ port, host });
    wss.on('listening', () => {
        const metadata = {
            pid: process.pid,
            session: sessionName,
            protocol: protocol.def.name,
            host,
            port,
            startedAt: new Date().toISOString(),
        };
        writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        process.stderr.write(`[pw-ws-server] listening on ws://${host}:${port}\n`);
    });
    // --- Connection handling ---
    wss.on('connection', async (ws) => {
        // Build handler context for this client
        const ctx = buildContext(ws, wss, sessionName, source, protocol);
        // Run onConnect hook
        if (protocol.hooks.onConnect) {
            try {
                await protocol.hooks.onConnect(ctx);
            }
            catch (err) {
                process.stderr.write(`[pw-ws-server] onConnect hook error: ${err.message}\n`);
            }
        }
        // Handle incoming messages
        ws.on('message', async (raw) => {
            try {
                const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
                await dispatchMessage(msg, ctx, protocol);
            }
            catch (err) {
                try {
                    ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
                }
                catch { }
            }
        });
        // Run onDisconnect hook
        ws.on('close', async () => {
            if (protocol.hooks.onDisconnect) {
                try {
                    await protocol.hooks.onDisconnect(ctx);
                }
                catch { }
            }
        });
    });
    // --- Source adapter subscription (broadcast on change) ---
    if (source && protocol.def.source?.watch) {
        unsubscribe = source.subscribe(sessionName, (snapshot) => {
            const msg = JSON.stringify({
                type: 'event',
                source: protocol.def.name,
                session: sessionName,
                data: snapshot,
                timestamp: new Date().toISOString(),
            });
            for (const client of wss.clients) {
                if (client.readyState === WebSocket.OPEN) {
                    try {
                        client.send(msg);
                    }
                    catch { }
                }
            }
        });
    }
    // --- Session liveness check ---
    const sessionCheck = setInterval(() => {
        const sessionJsonPath = join(sessionDir, 'session.json');
        if (!existsSync(sessionJsonPath)) {
            process.stderr.write('[pw-ws-server] session gone, shutting down\n');
            shutdown();
            return;
        }
        try {
            const session = JSON.parse(readFileSync(sessionJsonPath, 'utf-8'));
            if (session.pid)
                process.kill(session.pid, 0);
        }
        catch {
            process.stderr.write('[pw-ws-server] session process dead, shutting down\n');
            shutdown();
        }
    }, 3000);
    function shutdown() {
        clearInterval(sessionCheck);
        if (unsubscribe)
            unsubscribe();
        wss.close();
        try {
            unlinkSync(metadataPath);
        }
        catch { }
        process.exit(0);
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    wss.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            process.stderr.write(`[pw-ws-server] port ${port} already in use\n`);
            process.exit(1);
        }
    });
}
// --- Message dispatch ---
async function dispatchMessage(msg, ctx, protocol) {
    const msgType = msg.type;
    if (!msgType) {
        ctx.send({ type: 'error', error: 'Message must have a "type" field' });
        return;
    }
    const handler = protocol.handlers.get(msgType);
    if (!handler) {
        ctx.send({ type: 'error', error: `Unknown message type: "${msgType}"` });
        return;
    }
    // Schema validation (if defined)
    if (handler.schema) {
        const { valid, errors } = validateSchema(handler.schema, msg);
        if (!valid) {
            ctx.send({ type: 'error', error: 'Validation failed', details: errors });
            return;
        }
    }
    // Execute handler
    try {
        const result = await handler.fn(msg, ctx);
        if (result !== undefined) {
            ctx.send(result);
        }
    }
    catch (err) {
        ctx.send({ type: 'error', error: `Handler error: ${err.message}` });
    }
}
// --- Handler context builder ---
function buildContext(ws, wss, session, source, protocol) {
    return {
        session,
        source,
        protocol,
        send: (data) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(typeof data === 'string' ? data : JSON.stringify(data));
            }
        },
        broadcast: (data) => {
            const msg = typeof data === 'string' ? data : JSON.stringify(data);
            for (const client of wss.clients) {
                if (client.readyState === WebSocket.OPEN) {
                    try {
                        client.send(msg);
                    }
                    catch { }
                }
            }
        },
    };
}
// --- Start ---
main().catch(err => {
    process.stderr.write(`[pw-ws-server] fatal: ${err.message}\n`);
    process.exit(1);
});

// monitor-ws-client.ts — WebSocket client for pw-ws-server's monitor protocol
//
// Connects to ws-server, receives snapshot on connect + real-time events
// when monitor state changes (via fs.watch in pw-ws-server).
//
// Design: pw-ws-server's source adapter watches monitor-tabs.json etc
// and pushes snapshots to all connected clients. We subscribe and forward
// state updates to a callback.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
function sessionDir(sessionName) {
    return join(homedir(), '.playwright-state', 'sessions', sessionName);
}
function wsMetaPath(sessionName) {
    return join(sessionDir(sessionName), 'ws-server.json');
}
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function readWsMeta(sessionName) {
    const p = wsMetaPath(sessionName);
    if (!existsSync(p))
        return null;
    try {
        const meta = JSON.parse(readFileSync(p, 'utf-8'));
        if (!meta?.pid || !meta?.port || !meta?.host)
            return null;
        if (!isAlive(meta.pid))
            return null;
        return meta;
    }
    catch {
        return null;
    }
}
/**
 * Ensure pw-ws-server is running for the session with monitor protocol.
 * If not running, spawn it via the ws-server-start mechanism.
 */
async function ensureWsServer(sessionName) {
    const existing = readWsMeta(sessionName);
    if (existing)
        return existing;
    // Locate pw-ws-server's server.ts in the toybox
    const toyboxDir = join(homedir(), '.playwright-state', 'toybox', 'pw-ws-server');
    if (!existsSync(toyboxDir))
        return null;
    const serverScript = existsSync(join(toyboxDir, 'dist', 'server.js'))
        ? join(toyboxDir, 'dist', 'server.js')
        : join(toyboxDir, 'src', 'server.ts');
    if (!existsSync(serverScript))
        return null;
    const child = spawn(process.execPath, [...process.execArgv, serverScript, sessionName, '--port=47831', '--host=127.0.0.1', '--protocol=monitor'], { detached: true, stdio: 'ignore', cwd: process.cwd() });
    child.unref();
    // Poll for metadata file (max 3s)
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 150));
        const meta = readWsMeta(sessionName);
        if (meta)
            return meta;
    }
    return null;
}
/**
 * Subscribe to monitor state updates via WebSocket.
 * Returns immediately after receiving the initial snapshot.
 * Subsequent state changes invoke onUpdate with the latest snapshot.
 */
export async function subscribeMonitor(sessionName, onUpdate) {
    const meta = await ensureWsServer(sessionName);
    if (!meta) {
        // Fallback: no ws-server available, return empty subscription
        // Caller should fall back to file polling
        throw new Error('pw-ws-server not available');
    }
    const url = `ws://${meta.host}:${meta.port}`;
    const ws = new WebSocket(url);
    let snapshotReceived;
    const snapshotPromise = new Promise((resolve, reject) => {
        snapshotReceived = resolve;
        setTimeout(() => reject(new Error('ws monitor snapshot timeout')), 5000);
    });
    ws.addEventListener('message', (event) => {
        try {
            const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
            if (msg.type === 'snapshot' && msg.data) {
                snapshotReceived(msg.data);
                // Also deliver to onUpdate for consistency
                onUpdate(msg.data);
            }
            else if (msg.type === 'event' && msg.data) {
                onUpdate(msg.data);
            }
        }
        catch { }
    });
    ws.addEventListener('error', () => {
        // Silent; next message read will fail anyway
    });
    // Wait for open
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws connect timeout')), 3000);
        ws.addEventListener('open', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
        ws.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('ws connect error'));
        }, { once: true });
    });
    const initial = await snapshotPromise;
    return {
        initial,
        close: () => {
            try {
                ws.close();
            }
            catch { }
        },
    };
}

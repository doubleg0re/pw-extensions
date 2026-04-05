// native-dialog.ts — spawns Tauri/wry webview renderer with stdin/stdout IPC
//
// Protocol (line-delimited JSON):
//   stdin  ← parent writes: {"type":"init",...} / {"type":"visible",...} / {"type":"exit"}
//   stdout → parent reads:  {"type":"ready"} / {"type":"clicked",...}
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { subscribeMonitor } from './monitor-ws-client.js';
export function resolveNativeDialogBinary() {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const exeName = process.platform === 'win32'
        ? 'pw-user-action-renderer.exe'
        : 'pw-user-action-renderer';
    const candidates = [
        join(moduleDir, '..', 'bin', exeName),
        join(moduleDir, exeName),
        join(moduleDir, '..', 'dist', exeName),
    ];
    return candidates.find(candidate => existsSync(candidate)) || candidates[0];
}
export function canUseNativeDialog() {
    return existsSync(resolveNativeDialogBinary());
}
export async function showNativeDialog(opts) {
    const binaryPath = resolveNativeDialogBinary();
    if (!existsSync(binaryPath)) {
        throw new Error(`pw-user-action native dialog binary not found: ${binaryPath}`);
    }
    const requestId = randomUUID();
    const child = spawn(binaryPath, [], {
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: false,
    });
    opts.runtime?.registerCleanup?.(() => {
        try {
            if (!child.killed) {
                child.stdin?.write(JSON.stringify({ type: 'exit' }) + '\n');
                child.stdin?.end();
                setTimeout(() => { if (!child.killed)
                    child.kill(); }, 500);
            }
        }
        catch { }
    });
    // Send init command
    const initCmd = {
        type: 'init',
        id: requestId,
        prompt: opts.prompt,
        actions: opts.actions,
    };
    child.stdin.write(JSON.stringify(initCmd) + '\n');
    let exitCode = null;
    let exitSignal = null;
    let exitError = null;
    child.once('error', err => { exitError = err; });
    child.once('exit', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
    });
    // Set up line-delimited stdout reader
    const events = [];
    const eventWaiters = [];
    let stdoutBuffer = '';
    child.stdout.on('data', chunk => {
        stdoutBuffer += chunk.toString('utf-8');
        let idx;
        while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
            const line = stdoutBuffer.slice(0, idx).trim();
            stdoutBuffer = stdoutBuffer.slice(idx + 1);
            if (!line)
                continue;
            try {
                const ev = JSON.parse(line);
                if (eventWaiters.length > 0) {
                    const waiter = eventWaiters.shift();
                    waiter(ev);
                }
                else {
                    events.push(ev);
                }
            }
            catch { }
        }
    });
    function nextEvent(timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            if (events.length > 0) {
                resolve(events.shift());
                return;
            }
            const timer = setTimeout(() => {
                const idx = eventWaiters.indexOf(resolver);
                if (idx >= 0)
                    eventWaiters.splice(idx, 1);
                reject(new Error('Renderer event timeout'));
            }, timeoutMs);
            const resolver = (e) => {
                clearTimeout(timer);
                resolve(e);
            };
            eventWaiters.push(resolver);
        });
    }
    try {
        // Wait for ready event
        const readyTimeoutMs = 10000;
        const readyDeadline = Date.now() + readyTimeoutMs;
        let ready = false;
        while (!ready) {
            if (exitError)
                throw exitError;
            if (exitCode !== null || exitSignal !== null) {
                throw new Error(`Renderer exited before ready (code=${exitCode}, signal=${exitSignal})`);
            }
            if (Date.now() > readyDeadline) {
                throw new Error('Renderer did not become ready within 10s');
            }
            const ev = await nextEvent(1000).catch(() => null);
            if (ev?.type === 'ready') {
                ready = true;
            }
        }
        // Subscribe to monitor state via pw-ws-server (real-time via fs.watch)
        // Falls back to opts.visible if ws-server isn't available
        let subscription = null;
        let lastSentVisible = null;
        const computeVisible = (state) => {
            if (state.browserVisible === false)
                return false;
            if (state.browserFocused === false)
                return false;
            const active = state.activeTabId;
            if (active === null || active === undefined)
                return true;
            return active === opts.tabId;
        };
        const sendVisibility = (visible) => {
            if (visible === lastSentVisible)
                return;
            try {
                child.stdin.write(JSON.stringify({ type: 'visible', value: visible }) + '\n');
                lastSentVisible = visible;
                process.stderr.write(`[native-dialog] → renderer visible=${visible}\n`);
            }
            catch { }
        };
        try {
            subscription = await subscribeMonitor(opts.session, (state) => {
                sendVisibility(computeVisible(state));
            });
            process.stderr.write(`[native-dialog] ws monitor subscribed, initial state: ${JSON.stringify({
                activeTabId: subscription.initial.activeTabId,
                browserVisible: subscription.initial.browserVisible,
                browserFocused: subscription.initial.browserFocused,
            })}\n`);
            // Initial state already delivered via onUpdate in subscribeMonitor
        }
        catch (err) {
            process.stderr.write(`[native-dialog] ws subscribe failed: ${err.message}, using initial visible\n`);
            sendVisibility(opts.visible ?? true);
        }
        try {
            // Wait for clicked event
            while (true) {
                if (exitError)
                    throw exitError;
                if (exitCode !== null || exitSignal !== null) {
                    throw new Error(`Renderer exited unexpectedly (code=${exitCode}, signal=${exitSignal})`);
                }
                const ev = await nextEvent(60000);
                if (ev.type === 'clicked' && ev.action) {
                    if (!opts.actions.includes(ev.action)) {
                        throw new Error(`Renderer returned unexpected action "${ev.action}"`);
                    }
                    return {
                        id: requestId,
                        action: ev.action,
                        session: opts.session,
                        tabId: opts.tabId,
                        submittedAt: ev.submittedAt || new Date().toISOString(),
                    };
                }
            }
        }
        finally {
            subscription?.close();
        }
    }
    finally {
        if (!child.killed && exitCode === null && exitSignal === null) {
            try {
                child.stdin?.write(JSON.stringify({ type: 'exit' }) + '\n');
                child.stdin?.end();
            }
            catch { }
            setTimeout(() => { if (!child.killed)
                child.kill(); }, 500);
        }
    }
}

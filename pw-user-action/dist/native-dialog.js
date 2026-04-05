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
    // Send init command (title optional, defaults to "pw-user-action" in renderer)
    const initCmd = {
        type: 'init',
        id: requestId,
        prompt: opts.prompt,
        actions: opts.actions,
    };
    if (opts.title)
        initCmd.title = opts.title;
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
        // Subscribe to pw-monitor state via the pw-monitor client module.
        // Transport (pw-ws-server) is a private implementation detail.
        let subscription = null;
        let lastSentVisible = null;
        // If the caller didn't pass a concrete tabId we lock onto whatever tab
        // is active at subscription time. That becomes the dialog's "owner" tab.
        let ownerTabId = opts.tabId && opts.tabId > 0 ? opts.tabId : null;
        // Visibility rules — hide the dialog when:
        //   (a) browser is minimized (browserVisible === false)
        //   (b) some other app (terminal, another browser, ...) has focus
        //       (browserFocused === false)
        //   (c) user switched to a different tab in the same browser session
        //       (active !== ownerTabId)
        // Case (b) is the important one: the dialog should not float over an
        // unrelated app. The sidecar skips state updates while the dialog
        // itself holds foreground (fgType=dialog branch), so dialog focus does
        // NOT flip browserFocused to false.
        const computeVisible = (state) => {
            if (state.browserVisible === false)
                return false;
            if (state.browserFocused === false)
                return false;
            const active = state.activeTabId;
            if (ownerTabId == null) {
                // Lock onto first non-null activeTabId
                if (typeof active === 'number' && active > 0)
                    ownerTabId = active;
                return true;
            }
            if (active === null || active === undefined)
                return true;
            return active === ownerTabId;
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
            process.stderr.write(`[native-dialog] monitor subscribed, initial state: ${JSON.stringify({
                activeTabId: subscription.initial.activeTabId,
                browserVisible: subscription.initial.browserVisible,
                browserFocused: subscription.initial.browserFocused,
            })}\n`);
            sendVisibility(computeVisible(subscription.initial));
        }
        catch (err) {
            process.stderr.write(`[native-dialog] monitor subscribe failed: ${err?.message || String(err)}, defaulting to visible\n`);
            sendVisibility(true);
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

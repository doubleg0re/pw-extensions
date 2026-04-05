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
// active-win: OS-level foreground window detection (cross-platform)
let activeWin = null;
async function loadActiveWin() {
    if (activeWin)
        return activeWin;
    try {
        const mod = await import('active-win');
        activeWin = mod.default;
        return activeWin;
    }
    catch (e) {
        process.stderr.write(`[monitor-sidecar] active-win load failed: ${e.message}\n`);
        return null;
    }
}
const [, , cdpEndpoint, sessionName, registryPath] = process.argv;
if (!cdpEndpoint || !sessionName || !registryPath) {
    process.stderr.write('Usage: monitor-sidecar.ts <cdpEndpoint> <sessionName> <registryPath>\n');
    process.exit(1);
}
let nextId = 1;
let activeTabId = null;
let browserVisible = true; // tracks window state (not minimized)
let browserFocused = true; // tracks OS-level foreground window == browser
let browserPid = null; // from session.json
const tabs = new Map();
// Resolve browser PID from session.json (same directory as registry)
function resolveBrowserPid() {
    try {
        const sessionFile = join(dirname(registryPath), 'session.json');
        if (!existsSync(sessionFile))
            return null;
        const data = JSON.parse(readFileSync(sessionFile, 'utf-8'));
        return typeof data.pid === 'number' ? data.pid : null;
    }
    catch {
        return null;
    }
}
// Cached descendant PIDs (of Playwright Chromium main PID)
let descendantPids = new Set();
let descendantPidsUpdatedAt = 0;
const DESCENDANT_CACHE_TTL_MS = 2000;
async function updateDescendantPids() {
    if (browserPid == null)
        return;
    const now = Date.now();
    if (now - descendantPidsUpdatedAt < DESCENDANT_CACHE_TTL_MS)
        return;
    try {
        const { execSync } = await import('child_process');
        const parentMap = new Map();
        if (process.platform === 'win32') {
            // Windows: wmic
            const output = execSync('wmic process get ProcessId,ParentProcessId /format:csv', {
                encoding: 'utf-8',
                timeout: 3000,
                windowsHide: true,
            });
            const lines = output.split('\n').slice(1);
            for (const line of lines) {
                const parts = line.trim().split(',');
                if (parts.length >= 3) {
                    const ppid = parseInt(parts[1]);
                    const pid = parseInt(parts[2]);
                    if (!isNaN(pid) && !isNaN(ppid))
                        parentMap.set(pid, ppid);
                }
            }
        }
        else {
            // macOS/Linux: ps -e -o pid,ppid
            const output = execSync('ps -e -o pid=,ppid=', {
                encoding: 'utf-8',
                timeout: 3000,
            });
            for (const line of output.split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                    const pid = parseInt(parts[0]);
                    const ppid = parseInt(parts[1]);
                    if (!isNaN(pid) && !isNaN(ppid))
                        parentMap.set(pid, ppid);
                }
            }
        }
        const descendants = new Set([browserPid]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const [pid, ppid] of parentMap) {
                if (descendants.has(ppid) && !descendants.has(pid)) {
                    descendants.add(pid);
                    changed = true;
                }
            }
        }
        descendantPids = descendants;
        descendantPidsUpdatedAt = now;
    }
    catch { }
}
// Check foreground: returns
//   { type: 'browser', bounds: ... } if foreground is our browser
//   { type: 'dialog' } if foreground is a pw-user-action-renderer
//   null otherwise
async function getForegroundInfo() {
    const aw = await loadActiveWin();
    if (!aw)
        return null;
    try {
        const win = await aw();
        const fgPid = win?.owner?.processId;
        const fgPath = typeof win?.owner?.path === 'string' ? win.owner.path.toLowerCase() : '';
        if (typeof fgPid !== 'number')
            return null;
        // Check if foreground is our pw-user-action-renderer dialog
        if (fgPath.includes('pw-user-action-renderer')) {
            return { type: 'dialog' };
        }
        // Check if foreground is our browser process tree
        if (browserPid != null) {
            await updateDescendantPids();
            if (descendantPids.has(fgPid)) {
                return { type: 'browser', bounds: win?.bounds ?? null };
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
function boundsMatch(a, b) {
    if (!a || !b)
        return false;
    // Tolerance accounts for DPI scaling, window borders, taskbar-maximized
    // offsets, and Chromium's occasional rounding between getWindowBounds calls.
    const tolerance = 100;
    const dx = Math.abs((a.x ?? 0) - (b.x ?? 0));
    const dy = Math.abs((a.y ?? 0) - (b.y ?? 0));
    const dw = Math.abs((a.width ?? 0) - (b.width ?? 0));
    const dh = Math.abs((a.height ?? 0) - (b.height ?? 0));
    return dx < tolerance && dy < tolerance && dw < tolerance && dh < tolerance;
}
function findByCdpId(id) {
    for (const e of tabs.values()) {
        if (e.cdpTargetId === id)
            return e;
    }
    return undefined;
}
function persistRegistry() {
    const data = {
        nextId,
        tabs: Array.from(tabs.values()),
        activeTabId,
        browserVisible,
        browserFocused,
        sidecarPid: process.pid,
    };
    atomicWriteJSON(registryPath, data);
}
function restoreRegistry() {
    if (!existsSync(registryPath))
        return;
    try {
        const raw = JSON.parse(readFileSync(registryPath, 'utf-8'));
        if (raw.nextId)
            nextId = raw.nextId;
        // Don't restore tabs or activeTabId — those will be populated fresh from CDP
        // via Target.targetCreated events. Restoring stale tabs causes confusion.
        // Keep nextId so new tabs don't reuse old IDs.
    }
    catch { }
}
function atomicWriteJSON(filePath, data) {
    const dir = dirname(filePath);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.tmp-${randomBytes(4).toString('hex')}.json`);
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    try {
        unlinkSync(filePath);
    }
    catch { }
    renameSync(tmp, filePath);
}
// --- CDP WebSocket connection ---
async function connect() {
    restoreRegistry();
    browserPid = resolveBrowserPid();
    process.stderr.write(`[monitor-sidecar] browser pid from session: ${browserPid}\n`);
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
    let browserWsUrl;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        const info = await res.json();
        browserWsUrl = info.webSocketDebuggerUrl;
        if (!browserWsUrl)
            throw new Error('No webSocketDebuggerUrl in /json/version');
    }
    catch (err) {
        clearTimeout(startupTimeout);
        process.stderr.write(`Failed to get browser WS URL: ${err.message}\n`);
        process.exit(1);
    }
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    const pendingCdpResponses = new Map();
    function send(method, params, sessionId) {
        const id = msgId++;
        const msg = { id, method, params };
        if (sessionId)
            msg.sessionId = sessionId;
        ws.send(JSON.stringify(msg));
        return id;
    }
    /** Send CDP command and wait for response (with timeout) */
    function sendAndWait(method, params, timeoutMs = 2000, sessionId) {
        return new Promise((resolve, reject) => {
            const id = send(method, params, sessionId);
            const timer = setTimeout(() => {
                pendingCdpResponses.delete(id);
                reject(new Error(`CDP timeout: ${method}`));
            }, timeoutMs);
            pendingCdpResponses.set(id, (result) => {
                clearTimeout(timer);
                resolve(result);
            });
        });
    }
    // --- Event-based focus/visibility tracking via Runtime.addBinding ---
    //
    // For each page target, we:
    //   1. Target.attachToTarget (flatten) → get sessionId
    //   2. Runtime.addBinding({name:'__pwMonitorFocus', sessionId})
    //   3. Page.addScriptToEvaluateOnNewDocument (persists across navigations)
    //   4. Runtime.evaluate (immediate, for current page)
    //   5. Receive Runtime.bindingCalled events → update browserFocused
    //
    // Window state (minimized) is only checked when a focus event fires,
    // using Browser.getWindowBounds.
    const attachedSessions = new Map(); // cdpTargetId → sessionId
    const INJECT_SCRIPT = `
    (function() {
      if (window.__pwMonitorInstalled) return;
      window.__pwMonitorInstalled = true;
      let lastFocused = null;
      let lastVisible = null;
      function report(force) {
        try {
          const focused = document.hasFocus();
          const visible = document.visibilityState !== 'hidden';
          if (force || focused !== lastFocused || visible !== lastVisible) {
            lastFocused = focused;
            lastVisible = visible;
            window.__pwMonitorFocus(JSON.stringify({ focused, visible }));
          }
        } catch (e) {}
      }
      // Event-based: visibilitychange fires reliably, focus/blur sometimes too
      document.addEventListener('visibilitychange', () => report(false));
      window.addEventListener('focus', () => report(false), true);
      window.addEventListener('blur', () => report(false), true);
      // Fallback polling for cases where focus/blur events don't fire
      // (e.g. Playwright Chromium with --disable-renderer-backgrounding)
      setInterval(() => report(false), 300);
      // Initial report
      report(true);
    })();
  `;
    async function checkWindowState(cdpTargetId) {
        try {
            const winResult = await sendAndWait('Browser.getWindowForTarget', {
                targetId: cdpTargetId,
            });
            const windowId = winResult?.windowId;
            if (windowId == null)
                return browserVisible;
            const boundsResult = await sendAndWait('Browser.getWindowBounds', { windowId });
            const windowState = boundsResult?.bounds?.windowState;
            return windowState !== 'minimized';
        }
        catch {
            return browserVisible;
        }
    }
    async function attachAndInstrument(cdpTargetId) {
        if (attachedSessions.has(cdpTargetId))
            return;
        try {
            const attachResult = await sendAndWait('Target.attachToTarget', {
                targetId: cdpTargetId,
                flatten: true,
            });
            const sessionId = attachResult?.sessionId;
            if (!sessionId) {
                process.stderr.write(`[monitor-sidecar] attach failed, no sessionId for ${cdpTargetId}\n`);
                return;
            }
            attachedSessions.set(cdpTargetId, sessionId);
            process.stderr.write(`[monitor-sidecar] attached to ${cdpTargetId} sessionId=${sessionId}\n`);
            // Enable runtime + page for this session
            const rtRes = await sendAndWait('Runtime.enable', {}, 2000, sessionId).catch((e) => ({ error: e.message }));
            process.stderr.write(`[monitor-sidecar] Runtime.enable: ${JSON.stringify(rtRes)}\n`);
            await sendAndWait('Page.enable', {}, 2000, sessionId).catch(() => { });
            // Add binding for the page to call back
            const bindRes = await sendAndWait('Runtime.addBinding', {
                name: '__pwMonitorFocus',
            }, 2000, sessionId).catch((e) => ({ error: e.message }));
            process.stderr.write(`[monitor-sidecar] addBinding: ${JSON.stringify(bindRes)}\n`);
            // Inject on every new navigation
            await sendAndWait('Page.addScriptToEvaluateOnNewDocument', {
                source: INJECT_SCRIPT,
            }, 2000, sessionId).catch(() => { });
            // Inject into current page immediately
            await sendAndWait('Runtime.evaluate', {
                expression: INJECT_SCRIPT,
            }, 2000, sessionId).catch(() => { });
        }
        catch (e) {
            process.stderr.write(`[monitor-sidecar] attachAndInstrument error: ${e.message}\n`);
        }
    }
    async function handleFocusEvent(cdpTargetId, payload) {
        // Only react if this is the active tab
        const entry = findByCdpId(cdpTargetId);
        if (!entry || entry.tabId !== activeTabId)
            return;
        let data;
        try {
            data = JSON.parse(payload);
        }
        catch {
            return;
        }
        // If our dialog is the foreground window, Chromium will report
        // focused=false — that's cosmetic, not a real "user switched away".
        // Skip so browserFocused doesn't flip while the dialog is up.
        if (data.focused === false) {
            const fg = await getForegroundInfo();
            if (fg?.type === 'dialog')
                return;
        }
        // When focus returns, double-check window state (covers minimize)
        let newVisible = browserVisible;
        if (data.focused === true || data.visible === false) {
            newVisible = await checkWindowState(cdpTargetId);
        }
        else if (data.visible === true) {
            newVisible = true;
        }
        const newFocused = data.focused ?? browserFocused;
        if (newVisible !== browserVisible || newFocused !== browserFocused) {
            browserVisible = newVisible;
            browserFocused = newFocused;
            process.stderr.write(`[monitor-sidecar] focus event: visible=${browserVisible} focused=${browserFocused}\n`);
            persistRegistry();
        }
    }
    ws.addEventListener('open', () => {
        clearTimeout(startupTimeout);
        process.stderr.write(`[monitor-sidecar] connected to ${browserWsUrl}\n`);
        // Enable target discovery
        send('Target.setDiscoverTargets', { discover: true });
        // Poll active tab via CDP /json (first page target = active, best-effort)
        // Also polls window minimize state (visibilitychange doesn't fire in Playwright Chromium)
        let polling = false;
        setInterval(async () => {
            if (polling)
                return;
            polling = true;
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 2000);
                const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: controller.signal });
                clearTimeout(timeout);
                const targets = (await res.json()).filter((t) => t.type === 'page');
                // Note: /json's targets[0] gives the devtools-order top tab, which is
                // not the same as OS-level foreground. The focus check below resolves
                // activeTabId properly via bounds matching. Don't persist here.
                let jsonTopTabId = null;
                if (targets.length > 0) {
                    const topEntry = findByCdpId(targets[0].id);
                    if (topEntry)
                        jsonTopTabId = topEntry.tabId;
                }
                // Ensure all page targets are attached and instrumented
                for (const target of targets) {
                    void attachAndInstrument(target.id);
                }
                // Poll focus/visibility — tracked per-windowId, not per-tab.
                //
                // Rationale: tabs within the same window share one Chromium window,
                // so their "visible" state (minimized or not) is identical. Per-tab
                // state queries caused flicker because the "active tab" selection
                // could oscillate between tabs and we'd re-query an unrelated
                // window's state. Keying by windowId fixes that.
                if (tabs.size > 0) {
                    // One pass: build tab→windowId map and windowId→{bounds,state} map.
                    // Each unique windowId is queried only once per poll.
                    const tabToWindowId = new Map();
                    const windowStateMap = new Map();
                    for (const [tabId, entry] of tabs.entries()) {
                        try {
                            const winResult = await sendAndWait('Browser.getWindowForTarget', {
                                targetId: entry.cdpTargetId,
                            });
                            const windowId = winResult?.windowId;
                            if (windowId == null)
                                continue;
                            tabToWindowId.set(tabId, windowId);
                            if (!windowStateMap.has(windowId)) {
                                const boundsResult = await sendAndWait('Browser.getWindowBounds', { windowId });
                                const b = boundsResult?.bounds;
                                if (b) {
                                    windowStateMap.set(windowId, {
                                        bounds: { x: b.left, y: b.top, width: b.width, height: b.height },
                                        state: b.windowState || 'normal',
                                    });
                                }
                            }
                        }
                        catch { }
                    }
                    // Check OS foreground
                    const fgInfo = await getForegroundInfo();
                    let newActiveTabId = activeTabId;
                    let newActiveWindowId = activeTabId != null ? (tabToWindowId.get(activeTabId) ?? null) : null;
                    let newFocused = browserFocused;
                    if (fgInfo?.type === 'dialog') {
                        // Dialog is in foreground — keep current state as-is (prevent flicker)
                    }
                    else if (fgInfo?.type === 'browser') {
                        // Match foreground window by bounds. Prefer /json's top tab if its
                        // window's bounds match (handles same-window tab switching), else
                        // search all known windows (handles multi-window).
                        let matchedWindowId = null;
                        if (jsonTopTabId != null) {
                            const wid = tabToWindowId.get(jsonTopTabId);
                            if (wid != null && windowStateMap.has(wid) &&
                                boundsMatch(fgInfo.bounds, windowStateMap.get(wid).bounds)) {
                                matchedWindowId = wid;
                                newActiveTabId = jsonTopTabId;
                            }
                        }
                        if (matchedWindowId == null) {
                            for (const [wid, info] of windowStateMap.entries()) {
                                if (boundsMatch(fgInfo.bounds, info.bounds)) {
                                    matchedWindowId = wid;
                                    // Pick a tab belonging to this window; prefer jsonTopTab if it's in here
                                    if (jsonTopTabId != null && tabToWindowId.get(jsonTopTabId) === wid) {
                                        newActiveTabId = jsonTopTabId;
                                    }
                                    else {
                                        for (const [tid, w] of tabToWindowId.entries()) {
                                            if (w === wid) {
                                                newActiveTabId = tid;
                                                break;
                                            }
                                        }
                                    }
                                    break;
                                }
                            }
                        }
                        if (matchedWindowId != null) {
                            newActiveWindowId = matchedWindowId;
                            newFocused = true;
                        }
                        else {
                            newFocused = false;
                        }
                    }
                    else {
                        // Neither browser nor dialog is in foreground
                        newFocused = false;
                    }
                    // browserVisible: based on the active window's state. If the
                    // active window is unknown or state query failed, keep the
                    // previous value instead of flipping.
                    let newWindowVisible = browserVisible;
                    if (newActiveWindowId != null && windowStateMap.has(newActiveWindowId)) {
                        newWindowVisible = windowStateMap.get(newActiveWindowId).state !== 'minimized';
                    }
                    // Debug: log every poll
                    const fgB = fgInfo?.type === 'browser' ? fgInfo.bounds : null;
                    const fgType = fgInfo?.type || 'none';
                    const activeWinInfo = newActiveWindowId != null ? windowStateMap.get(newActiveWindowId) : null;
                    process.stderr.write(`[monitor-sidecar] poll: vis=${newWindowVisible} fc=${newFocused} tab=${newActiveTabId} win=${newActiveWindowId} fgType=${fgType} fg=${JSON.stringify(fgB)} activeWin=${JSON.stringify(activeWinInfo)} windows=${windowStateMap.size}\n`);
                    if (newWindowVisible !== browserVisible ||
                        newFocused !== browserFocused ||
                        newActiveTabId !== activeTabId) {
                        browserVisible = newWindowVisible;
                        browserFocused = newFocused;
                        activeTabId = newActiveTabId;
                        persistRegistry();
                    }
                }
            }
            catch { }
            polling = false;
        }, 150);
    });
    ws.addEventListener('message', (event) => {
        try {
            const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
            // Route CDP responses to pending promises
            if (msg.id != null && pendingCdpResponses.has(msg.id)) {
                const resolve = pendingCdpResponses.get(msg.id);
                pendingCdpResponses.delete(msg.id);
                resolve(msg.result);
            }
            // Debug: log all method events
            if (msg.method && !msg.method.startsWith('Target.')) {
                process.stderr.write(`[monitor-sidecar] CDP event: ${msg.method} session=${msg.sessionId || 'root'}\n`);
            }
            // Handle Runtime.bindingCalled (from injected focus/blur listeners)
            if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__pwMonitorFocus') {
                const sessionId = msg.sessionId;
                let cdpTargetId;
                for (const [tid, sid] of attachedSessions) {
                    if (sid === sessionId) {
                        cdpTargetId = tid;
                        break;
                    }
                }
                process.stderr.write(`[monitor-sidecar] bindingCalled: sessionId=${sessionId} → cdpTargetId=${cdpTargetId || 'NOT FOUND'} payload=${msg.params.payload}\n`);
                if (cdpTargetId) {
                    void handleFocusEvent(cdpTargetId, msg.params.payload || '{}');
                }
            }
            // Handle target detachment — clean up attached session
            if (msg.method === 'Target.detachedFromTarget') {
                const sessionId = msg.params?.sessionId;
                if (sessionId) {
                    for (const [tid, sid] of attachedSessions) {
                        if (sid === sessionId) {
                            attachedSessions.delete(tid);
                            break;
                        }
                    }
                }
            }
            handleCdpEvent(msg);
        }
        catch { }
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
function handleCdpEvent(msg) {
    const { method, params } = msg;
    if (!method || !params)
        return;
    const now = new Date().toISOString();
    switch (method) {
        case 'Target.targetCreated': {
            const { targetInfo } = params;
            if (targetInfo.type !== 'page')
                break;
            // Check if this target already exists (reconnect/discovery duplicate)
            const existing = findByCdpId(targetInfo.targetId);
            if (existing) {
                existing.url = targetInfo.url || existing.url;
                existing.title = targetInfo.title || existing.title;
                existing.lastSeenAt = now;
                persistRegistry();
                break;
            }
            const entry = {
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
                if (activeTabId === entry.tabId)
                    activeTabId = null;
                persistRegistry();
                process.stderr.write(`[monitor-sidecar] tab:closed tabId=${entry.tabId}\n`);
            }
            break;
        }
        case 'Target.targetInfoChanged': {
            const { targetInfo } = params;
            if (targetInfo.type !== 'page')
                break;
            const entry = findByCdpId(targetInfo.targetId);
            if (!entry)
                break;
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

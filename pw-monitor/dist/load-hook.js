// load-hook.ts — Per-command tab sync hook
// Runs at the start of every pw command when pw-monitor is active.
// If sidecar is alive, reads its registry directly (already fresh).
// Otherwise falls back to per-command CDP sync.
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { extractCdpPort, fetchTargets } from './cdp-targets.js';
import { loadStore } from './tab-store.js';
import { syncTabs } from './tab-sync.js';
function getSessionDir(sessionName) {
    return join(homedir(), '.playwright-state', 'sessions', sessionName);
}
function isSidecarAlive(registryPath) {
    if (!existsSync(registryPath))
        return false;
    try {
        const data = JSON.parse(readFileSync(registryPath, 'utf-8'));
        if (!data.sidecarPid)
            return false;
        process.kill(data.sidecarPid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export default async (ctx) => {
    const port = extractCdpPort(ctx.session?.cdpEndpoint);
    if (!port) {
        ctx.logger.warn('no CDP endpoint available, skipping tab sync');
        return;
    }
    const sessionDir = getSessionDir(ctx.session.name);
    const registryPath = join(sessionDir, 'monitor-tabs.json');
    // Load store (sidecar keeps it fresh, but we still sync for event emission)
    const store = loadStore(registryPath);
    const sidecarAlive = isSidecarAlive(registryPath);
    let liveTargets;
    try {
        liveTargets = await fetchTargets(port);
    }
    catch (err) {
        ctx.logger.warn(`CDP target fetch failed: ${err.message}, starting clean`);
        store.clear();
        store.save(registryPath);
        return;
    }
    const events = syncTabs(store, liveTargets, ctx.session.name);
    for (const evt of events) {
        ctx.emitEvent(evt.event, evt.payload);
    }
    store.save(registryPath);
    ctx.registerCleanup(() => store.save(registryPath));
    ctx.logger.info(`${sidecarAlive ? 'sidecar active, ' : ''}synced ${store.count()} tabs (${events.length} changes)`);
};

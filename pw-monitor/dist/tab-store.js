// tab-store.ts — Monitor-owned tab registry with persistence
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
/** Load tab store from file, or create empty store on failure */
export function loadStore(path) {
    let nextId = 1;
    let activeTabId = null;
    const tabs = new Map();
    // Restore from file
    if (existsSync(path)) {
        try {
            const raw = JSON.parse(readFileSync(path, 'utf-8'));
            if (raw.nextId)
                nextId = raw.nextId;
            if (raw.activeTabId != null)
                activeTabId = raw.activeTabId;
            if (Array.isArray(raw.tabs)) {
                for (const entry of raw.tabs) {
                    tabs.set(entry.tabId, entry);
                }
            }
        }
        catch {
            // Recovery failure fallback: clean start
            nextId = 1;
            activeTabId = null;
            tabs.clear();
        }
    }
    const store = {
        get: (tabId) => tabs.get(tabId),
        findByCdpId: (cdpTargetId) => {
            for (const e of tabs.values()) {
                if (e.cdpTargetId === cdpTargetId)
                    return e;
            }
            return undefined;
        },
        findByUrl: (url) => {
            for (const e of tabs.values()) {
                if (e.url === url)
                    return e;
            }
            return undefined;
        },
        all: () => Array.from(tabs.values()),
        count: () => tabs.size,
        add: (partial) => {
            const now = new Date().toISOString();
            const entry = {
                tabId: nextId++,
                ...partial,
                createdAt: now,
                lastSeenAt: now,
            };
            tabs.set(entry.tabId, entry);
            return entry;
        },
        update: (tabId, updates) => {
            const entry = tabs.get(tabId);
            if (entry)
                Object.assign(entry, updates);
        },
        remove: (tabId) => { tabs.delete(tabId); },
        clear: () => { tabs.clear(); nextId = 1; activeTabId = null; },
        save: (savePath) => {
            const data = { nextId, tabs: Array.from(tabs.values()), activeTabId };
            atomicWriteJSON(savePath, data);
        },
        getActiveTabId: () => activeTabId,
        setActiveTabId: (tabId) => { activeTabId = tabId; },
    };
    return store;
}
/** Atomic JSON write: temp file → rename (Windows-safe) */
function atomicWriteJSON(filePath, data) {
    const tmp = join(dirname(filePath), `.tmp-${randomBytes(4).toString('hex')}.json`);
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    try {
        unlinkSync(filePath);
    }
    catch { }
    renameSync(tmp, filePath);
}

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { sessionStateDir } from './state.js';
export function monitorTabsPath(sessionName) {
    return join(sessionStateDir(sessionName), 'monitor-tabs.json');
}
export function readActiveTabId(sessionName) {
    const state = loadMonitorTabsState(sessionName);
    if (!state)
        return undefined;
    if (typeof state.activeTabId === 'number')
        return state.activeTabId;
    if (state.activeTabId === null)
        return null;
    return undefined;
}
export function resolveMonitorTabId(sessionName, pageUrl, fallbackTabId) {
    if (!sessionName)
        return fallbackTabId;
    const state = loadMonitorTabsState(sessionName);
    if (!state?.tabs?.length)
        return fallbackTabId;
    // Prefer active tab if URL matches — this handles stale duplicates
    if (pageUrl && typeof state.activeTabId === 'number') {
        const active = state.tabs.find(tab => tab.tabId === state.activeTabId);
        if (active && active.url === pageUrl)
            return state.activeTabId;
    }
    if (fallbackTabId > 0 && state.tabs.some(tab => tab.tabId === fallbackTabId)) {
        return fallbackTabId;
    }
    if (pageUrl) {
        // Match by URL, prefer the most recently created entry (last in array)
        const matched = [...state.tabs].reverse().find(tab => tab.url === pageUrl);
        if (matched)
            return matched.tabId;
    }
    return fallbackTabId;
}
function loadMonitorTabsState(sessionName) {
    const path = monitorTabsPath(sessionName);
    if (!existsSync(path))
        return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch { }
    return undefined;
}
export function isBrowserVisible(sessionName) {
    if (!sessionName)
        return true;
    const state = loadMonitorTabsState(sessionName);
    if (!state)
        return true;
    return state.browserVisible !== false;
}
export function isBrowserFocused(sessionName) {
    if (!sessionName)
        return true;
    const state = loadMonitorTabsState(sessionName);
    if (!state)
        return true;
    // Undefined (older monitor) → assume focused
    if (state.browserFocused === undefined)
        return true;
    return state.browserFocused;
}
export function isTabVisible(sessionName, tabId) {
    if (!sessionName)
        return true;
    // Browser window hidden (minimized) → nothing is visible
    if (!isBrowserVisible(sessionName))
        return false;
    // Browser not focused (other window on top) → nothing is visible
    if (!isBrowserFocused(sessionName))
        return false;
    const activeTabId = readActiveTabId(sessionName);
    if (activeTabId === undefined)
        return true;
    if (activeTabId === null)
        return false;
    return activeTabId === tabId;
}

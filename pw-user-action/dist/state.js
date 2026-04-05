// state.ts — Pending user-action state persistence
// Stores overlay configuration per session+tabId so it can be
// re-injected after navigation or tab switch.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
export function sessionStateDir(sessionName) {
    return join(homedir(), '.playwright-state', 'sessions', sessionName);
}
function statePath(sessionName) {
    return join(sessionStateDir(sessionName), 'pending-actions.json');
}
export function requestPath(sessionName) {
    return join(sessionStateDir(sessionName), 'user-action-request.json');
}
export function responsePath(sessionName) {
    return join(sessionStateDir(sessionName), 'user-action-response.json');
}
export function loadPending(sessionName) {
    const path = statePath(sessionName);
    if (!existsSync(path))
        return [];
    try {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        return Array.isArray(data.pending) ? data.pending : [];
    }
    catch {
        return [];
    }
}
export function savePending(sessionName, pending) {
    const path = statePath(sessionName);
    const dir = dirname(path);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    atomicWriteJSON(path, { pending });
}
export function addPending(sessionName, action) {
    const lockPath = join(sessionStateDir(sessionName), '.pending-actions.lock');
    simpleLock(lockPath);
    try {
        const list = loadPending(sessionName);
        const filtered = list.filter(p => p.tabId !== action.tabId);
        filtered.push(action);
        savePending(sessionName, filtered);
    }
    finally {
        simpleUnlock(lockPath);
    }
}
export function removePending(sessionName, tabId) {
    const lockPath = join(sessionStateDir(sessionName), '.pending-actions.lock');
    simpleLock(lockPath);
    try {
        const list = loadPending(sessionName);
        savePending(sessionName, list.filter(p => p.tabId !== tabId));
    }
    finally {
        simpleUnlock(lockPath);
    }
}
export function updatePending(sessionName, tabId, updates) {
    const lockPath = join(sessionStateDir(sessionName), '.pending-actions.lock');
    simpleLock(lockPath);
    try {
        const list = loadPending(sessionName);
        const next = list.map(entry => entry.tabId === tabId ? { ...entry, ...updates } : entry);
        savePending(sessionName, next);
    }
    finally {
        simpleUnlock(lockPath);
    }
}
export function getPending(sessionName, tabId) {
    return loadPending(sessionName).find(p => p.tabId === tabId);
}
export function clearAll(sessionName) {
    savePending(sessionName, []);
}
export function saveRequest(sessionName, request) {
    const path = requestPath(sessionName);
    const dir = dirname(path);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    atomicWriteJSON(path, request);
}
export function loadRequest(sessionName) {
    return loadJSON(requestPath(sessionName));
}
export function clearRequest(sessionName) {
    safeUnlink(requestPath(sessionName));
}
export function updateRequest(sessionName, updates) {
    const current = loadRequest(sessionName);
    if (!current)
        return undefined;
    const next = { ...current, ...updates };
    saveRequest(sessionName, next);
    return next;
}
export function saveResponse(sessionName, response) {
    const path = responsePath(sessionName);
    const dir = dirname(path);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    atomicWriteJSON(path, response);
}
export function loadResponse(sessionName) {
    return loadJSON(responsePath(sessionName));
}
export function clearResponse(sessionName) {
    safeUnlink(responsePath(sessionName));
}
// Simple file lock (self-contained, no core dependency)
function simpleLock(lockPath) {
    const maxRetries = 20;
    for (let i = 0; i < maxRetries; i++) {
        try {
            writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
            return;
        }
        catch {
            // Lock exists — check if owner is still alive
            try {
                const ownerPid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
                if (ownerPid && ownerPid !== process.pid) {
                    try {
                        process.kill(ownerPid, 0);
                    }
                    catch {
                        // Owner dead — stale lock, safe to take
                        try {
                            unlinkSync(lockPath);
                        }
                        catch { }
                        continue;
                    }
                }
            }
            catch { }
            const sleep = (ms) => { const end = Date.now() + ms; while (Date.now() < end)
                ; };
            sleep(50);
        }
    }
    throw new Error(`Failed to acquire lock: ${lockPath}`);
}
function simpleUnlock(lockPath) {
    try {
        // Only release if we own the lock
        const ownerPid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
        if (!ownerPid || ownerPid === process.pid) {
            safeUnlink(lockPath);
        }
    }
    catch { }
}
function atomicWriteJSON(filePath, data) {
    const tmp = join(dirname(filePath), `.tmp-${randomBytes(4).toString('hex')}.json`);
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    safeUnlink(filePath);
    renameSync(tmp, filePath);
}
function loadJSON(filePath) {
    if (!existsSync(filePath))
        return undefined;
    try {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
    }
    catch {
        return undefined;
    }
}
function safeUnlink(filePath) {
    try {
        unlinkSync(filePath);
    }
    catch { }
}

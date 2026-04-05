// pw-monitor source adapter — reads monitor state files and watches for changes
import { readFileSync, existsSync, watch } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
function sessionDir(sessionName) {
    return join(homedir(), '.playwright-state', 'sessions', sessionName);
}
function readJsonSafe(path) {
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
function buildSnapshot(sessionName) {
    const dir = sessionDir(sessionName);
    const tabs = readJsonSafe(join(dir, 'monitor-tabs.json'));
    const session = readJsonSafe(join(dir, 'session.json'));
    const pendingActions = readJsonSafe(join(dir, 'pending-actions.json'));
    return {
        session: session ? {
            name: session.name,
            id: session.id,
            pid: session.pid,
            cdpEndpoint: session.cdpEndpoint,
            startedAt: session.startedAt,
        } : null,
        tabs: tabs?.tabs || [],
        activeTabId: tabs?.activeTabId ?? null,
        sidecarPid: tabs?.sidecarPid ?? null,
        sidecarAlive: tabs?.sidecarPid ? isAlive(tabs.sidecarPid) : false,
        pendingActions: pendingActions?.pending || [],
        timestamp: new Date().toISOString(),
    };
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
export const pwMonitorAdapter = {
    name: 'pw-monitor',
    readSnapshot(sessionName) {
        return buildSnapshot(sessionName);
    },
    subscribe(sessionName, emit) {
        const dir = sessionDir(sessionName);
        if (!existsSync(dir))
            return () => { };
        let prevJson = '';
        let debounce = null;
        const watcher = watch(dir, { recursive: false }, () => {
            if (debounce)
                clearTimeout(debounce);
            debounce = setTimeout(() => {
                const snapshot = buildSnapshot(sessionName);
                const json = JSON.stringify(snapshot);
                if (json !== prevJson) {
                    prevJson = json;
                    emit(snapshot);
                }
            }, 30);
        });
        return () => { watcher.close(); };
    },
};

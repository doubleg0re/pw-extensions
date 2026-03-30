// utils.ts — Shared utilities for pw-ws-server actions
import { join } from 'path';
import { homedir } from 'os';
export function resolveSessionName(args, runtime) {
    return args?.session || runtime?.session?.name || null;
}
export function sessionDir(sessionName) {
    return join(homedir(), '.playwright-state', 'sessions', sessionName);
}
export function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}

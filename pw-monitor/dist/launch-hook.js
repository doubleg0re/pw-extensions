// launch-hook.ts — Spawn monitor sidecar on browser launch
// Starts a detached background process that connects to CDP WebSocket
// and tracks tab lifecycle in real-time.
import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, openSync } from 'fs';
function getSessionDir(sessionName) {
    return join(homedir(), '.playwright-state', 'sessions', sessionName);
}
function isSidecarAlive(sessionDir) {
    const registryPath = join(sessionDir, 'monitor-tabs.json');
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
    const sessionName = ctx.session?.name;
    const cdpEndpoint = ctx.session?.cdpEndpoint;
    if (!sessionName || !cdpEndpoint) {
        ctx.logger.warn('no session or CDP endpoint, skipping sidecar launch');
        return;
    }
    const sessionDir = getSessionDir(sessionName);
    const registryPath = join(sessionDir, 'monitor-tabs.json');
    // Don't spawn if sidecar already running
    if (isSidecarAlive(sessionDir)) {
        ctx.logger.info('sidecar already running');
        return;
    }
    // Spawn detached sidecar — resolve .js (built) or .ts (source/tsx)
    const scriptDir = import.meta.dirname || __dirname;
    const sidecarScript = existsSync(join(scriptDir, 'monitor-sidecar.js'))
        ? join(scriptDir, 'monitor-sidecar.js')
        : join(scriptDir, 'monitor-sidecar.ts');
    // Open log file for sidecar stderr
    const logPath = join(sessionDir, 'sidecar.log');
    const logFd = openSync(logPath, 'a');
    const child = spawn(process.execPath, [...process.execArgv, sidecarScript, cdpEndpoint, sessionName, registryPath], {
        detached: true,
        stdio: ['ignore', 'ignore', logFd],
        cwd: process.cwd(),
    });
    child.unref();
    ctx.logger.info(`sidecar spawned (pid=${child.pid})`);
    // Register cleanup to kill sidecar
    ctx.registerCleanup(() => {
        try {
            if (child.pid)
                process.kill(child.pid);
        }
        catch { }
    });
};

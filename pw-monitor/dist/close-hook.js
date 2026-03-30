// close-hook.ts — Session close cleanup
// Kills sidecar process if running, preserves registry for recovery.
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
function getSessionDir(sessionName) {
    return join(homedir(), '.playwright-state', 'sessions', sessionName);
}
export default async (ctx) => {
    const sessionName = ctx.session?.name;
    if (!sessionName)
        return;
    const sessionDir = getSessionDir(sessionName);
    const registryPath = join(sessionDir, 'monitor-tabs.json');
    // Kill sidecar if alive
    if (existsSync(registryPath)) {
        try {
            const data = JSON.parse(readFileSync(registryPath, 'utf-8'));
            if (data.sidecarPid) {
                process.kill(data.sidecarPid, 'SIGTERM');
                ctx.logger.info(`sidecar killed (pid=${data.sidecarPid})`);
            }
        }
        catch { }
    }
    // Kill GUI server if alive
    const guiPidPath = join(sessionDir, 'gui.pid');
    if (existsSync(guiPidPath)) {
        try {
            const guiPid = parseInt(readFileSync(guiPidPath, 'utf-8').trim(), 10);
            if (guiPid) {
                process.kill(guiPid, 'SIGTERM');
                ctx.logger.info(`gui server killed (pid=${guiPid})`);
            }
        }
        catch { }
    }
    ctx.logger.info('session closing, monitor state preserved for recovery');
};

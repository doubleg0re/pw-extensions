// ws-server-status — Check WebSocket server status
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { resolveSessionName, sessionDir, isAlive } from '../utils.js';
export default async function (page, args, runtime) {
    const sessionName = resolveSessionName(args, runtime);
    if (!sessionName)
        return { result: { error: 'No active session' } };
    const metadataPath = join(sessionDir(sessionName), 'ws-server.json');
    if (!existsSync(metadataPath)) {
        return { result: { running: false, session: sessionName } };
    }
    try {
        const meta = JSON.parse(readFileSync(metadataPath, 'utf-8'));
        const running = meta.pid ? isAlive(meta.pid) : false;
        return {
            result: {
                ...meta,
                running,
                url: `ws://${meta.host}:${meta.port}`,
            },
        };
    }
    catch {
        return { result: { running: false, session: sessionName, error: 'Corrupted metadata' } };
    }
}

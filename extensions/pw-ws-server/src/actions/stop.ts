// ws-server-stop — Stop WebSocket server for session
import { join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { resolveSessionName, sessionDir } from '../utils.js';

export default async function(page: any, args: any, runtime?: any): Promise<{ result?: any }> {
  const sessionName = resolveSessionName(args, runtime);
  if (!sessionName) return { result: { error: 'No active session' } };

  const metadataPath = join(sessionDir(sessionName), 'ws-server.json');

  if (!existsSync(metadataPath)) {
    return { result: { stopped: true, message: 'No WS server running' } };
  }

  try {
    const meta = JSON.parse(readFileSync(metadataPath, 'utf-8'));
    if (meta.pid) {
      try { process.kill(meta.pid, 'SIGTERM'); } catch {}
    }
    try { unlinkSync(metadataPath); } catch {}
    return { result: { stopped: true, pid: meta.pid } };
  } catch {
    return { result: { stopped: true, message: 'Cleaned stale metadata' } };
  }
}

// ws-server-start — Start WebSocket server for session
import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { resolveSessionName, sessionDir, isAlive } from '../utils.js';

export default async function(page: any, args: any, runtime?: any): Promise<{ result?: any }> {
  const sessionName = resolveSessionName(args, runtime);
  if (!sessionName) return { result: { error: 'No active session' } };

  const dir = sessionDir(sessionName);
  const metadataPath = join(dir, 'ws-server.json');
  const port = args?.port || args?.[0] || 47831;
  const host = args?.host || '127.0.0.1';
  const protocol = args?.protocol || 'monitor';
  const replace = args?.replace || false;

  // Check existing server
  if (existsSync(metadataPath)) {
    try {
      const meta = JSON.parse(readFileSync(metadataPath, 'utf-8'));
      if (meta.pid && isAlive(meta.pid)) {
        if (!replace) {
          return { result: { error: `WS server already running (pid=${meta.pid}, port=${meta.port}). Use replace to restart.` } };
        }
        try { process.kill(meta.pid, 'SIGTERM'); } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
    } catch {}
  }

  // Spawn server
  const serverScript = join(import.meta.dirname || __dirname, '..', 'server.ts');
  const child = spawn(
    process.execPath,
    [...process.execArgv, serverScript, sessionName, `--port=${port}`, `--host=${host}`, `--protocol=${protocol}`],
    { detached: true, stdio: 'ignore', cwd: process.cwd() },
  );
  child.unref();

  // Wait and verify server actually started
  const maxWait = 3000;
  const interval = 200;
  let waited = 0;
  while (waited < maxWait) {
    await new Promise(r => setTimeout(r, interval));
    waited += interval;
    if (existsSync(metadataPath)) {
      try {
        const meta = JSON.parse(readFileSync(metadataPath, 'utf-8'));
        if (meta.pid && isAlive(meta.pid)) {
          return {
            result: {
              started: true,
              pid: meta.pid,
              url: `ws://${meta.host}:${meta.port}`,
              protocol: meta.protocol,
              session: sessionName,
            },
          };
        }
      } catch {}
    }
  }

  return { result: { error: 'WS server failed to start (metadata not written within 3s). Check protocol and port.' } };
}

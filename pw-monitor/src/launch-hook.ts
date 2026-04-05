// launch-hook.ts — Spawn monitor sidecar on browser launch
// Starts a detached background process that connects to CDP WebSocket
// and tracks tab lifecycle in real-time.
import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, openSync } from 'fs';

function getSessionDir(sessionName: string): string {
  return join(homedir(), '.playwright-state', 'sessions', sessionName);
}

function isSidecarAlive(sessionDir: string): boolean {
  const registryPath = join(sessionDir, 'monitor-tabs.json');
  if (!existsSync(registryPath)) return false;
  try {
    const data = JSON.parse(readFileSync(registryPath, 'utf-8'));
    if (!data.sidecarPid) return false;
    process.kill(data.sidecarPid, 0);
    return true;
  } catch {
    return false;
  }
}

export default async (ctx: any) => {
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
  const child = spawn(
    process.execPath,
    [...process.execArgv, sidecarScript, cdpEndpoint, sessionName, registryPath],
    {
      detached: true,
      stdio: ['ignore', 'ignore', logFd],
      cwd: process.cwd(),
    },
  );
  child.unref();

  ctx.logger.info(`sidecar spawned (pid=${child.pid})`);

  // Register cleanup to kill sidecar
  ctx.registerCleanup(() => {
    try {
      if (child.pid) process.kill(child.pid);
    } catch {}
  });

  // Auto-start pw-ws-server if pw-ws-server extension is installed.
  // pw-ws-server will load this extension's provider (dist/provider.js)
  // and expose the pw-monitor/v1 protocol on WebSocket.
  await ensureWsServer(sessionName, sessionDir, ctx).catch((err) => {
    ctx.logger.warn(`pw-ws-server auto-start failed: ${err?.message || String(err)}`);
  });
};

async function ensureWsServer(sessionName: string, sessionDir: string, ctx: any): Promise<void> {
  const wsMetaPath = join(sessionDir, 'ws-server.json');

  // Already running?
  if (existsSync(wsMetaPath)) {
    try {
      const meta = JSON.parse(readFileSync(wsMetaPath, 'utf-8'));
      if (meta?.pid) {
        try {
          process.kill(meta.pid, 0);
          ctx.logger.info(`ws-server already running (pid=${meta.pid}, port=${meta.port})`);
          return;
        } catch {}
      }
    } catch {}
  }

  // Locate pw-ws-server in the toybox
  const wsToybox = join(homedir(), '.playwright-state', 'toybox', 'pw-ws-server');
  if (!existsSync(wsToybox)) {
    ctx.logger.warn('pw-ws-server not installed — real-time events unavailable');
    return;
  }

  const serverScript = existsSync(join(wsToybox, 'dist', 'server.js'))
    ? join(wsToybox, 'dist', 'server.js')
    : join(wsToybox, 'src', 'server.ts');

  if (!existsSync(serverScript)) {
    ctx.logger.warn(`pw-ws-server entry not found at ${serverScript}`);
    return;
  }

  const wsLogPath = join(sessionDir, 'ws-server.log');
  const wsLogFd = openSync(wsLogPath, 'a');
  const wsChild = spawn(
    process.execPath,
    [...process.execArgv, serverScript, sessionName, '--port=47831', '--host=127.0.0.1'],
    {
      detached: true,
      stdio: ['ignore', 'ignore', wsLogFd],
      cwd: process.cwd(),
    },
  );
  wsChild.unref();

  // Wait briefly for metadata to appear (best-effort)
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (existsSync(wsMetaPath)) break;
    await new Promise(r => setTimeout(r, 100));
  }

  if (existsSync(wsMetaPath)) {
    ctx.logger.info(`ws-server spawned (pid=${wsChild.pid})`);
  } else {
    ctx.logger.warn(`ws-server did not write metadata within 2s (pid=${wsChild.pid})`);
  }

  ctx.registerCleanup(() => {
    try {
      if (wsChild.pid) process.kill(wsChild.pid);
    } catch {}
  });
}

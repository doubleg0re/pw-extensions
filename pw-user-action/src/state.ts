// state.ts — Pending user-action state persistence
// Stores overlay configuration per session+tabId so it can be
// re-injected after navigation or tab switch.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { homedir } from 'os';

export type PendingActionRenderer = 'browser-overlay' | 'native-dialog';

export interface PendingAction {
  tabId: number;
  prompt: string;
  actions: string[];
  focus?: string;
  createdAt: string;
  renderer?: PendingActionRenderer;
  requestId?: string;
  visible?: boolean;
}

interface StateFile {
  pending: PendingAction[];
}

export interface UserActionRequest {
  id: string;
  session: string;
  tabId: number;
  prompt: string;
  actions: string[];
  focus?: string;
  createdAt: string;
  visible?: boolean;
}

export interface UserActionResponse {
  id: string;
  action: string;
  session: string;
  tabId: number;
  submittedAt: string;
}

export function sessionStateDir(sessionName: string): string {
  return join(homedir(), '.playwright-state', 'sessions', sessionName);
}

function statePath(sessionName: string): string {
  return join(sessionStateDir(sessionName), 'pending-actions.json');
}

export function requestPath(sessionName: string): string {
  return join(sessionStateDir(sessionName), 'user-action-request.json');
}

export function responsePath(sessionName: string): string {
  return join(sessionStateDir(sessionName), 'user-action-response.json');
}

export function loadPending(sessionName: string): PendingAction[] {
  const path = statePath(sessionName);
  if (!existsSync(path)) return [];
  try {
    const data: StateFile = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(data.pending) ? data.pending : [];
  } catch {
    return [];
  }
}

export function savePending(sessionName: string, pending: PendingAction[]): void {
  const path = statePath(sessionName);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteJSON(path, { pending });
}

export function addPending(sessionName: string, action: PendingAction): void {
  const lockPath = join(sessionStateDir(sessionName), '.pending-actions.lock');
  simpleLock(lockPath);
  try {
    const list = loadPending(sessionName);
    const filtered = list.filter(p => p.tabId !== action.tabId);
    filtered.push(action);
    savePending(sessionName, filtered);
  } finally {
    simpleUnlock(lockPath);
  }
}

export function removePending(sessionName: string, tabId: number): void {
  const lockPath = join(sessionStateDir(sessionName), '.pending-actions.lock');
  simpleLock(lockPath);
  try {
    const list = loadPending(sessionName);
    savePending(sessionName, list.filter(p => p.tabId !== tabId));
  } finally {
    simpleUnlock(lockPath);
  }
}

export function updatePending(sessionName: string, tabId: number, updates: Partial<PendingAction>): void {
  const lockPath = join(sessionStateDir(sessionName), '.pending-actions.lock');
  simpleLock(lockPath);
  try {
    const list = loadPending(sessionName);
    const next = list.map(entry => entry.tabId === tabId ? { ...entry, ...updates } : entry);
    savePending(sessionName, next);
  } finally {
    simpleUnlock(lockPath);
  }
}

export function getPending(sessionName: string, tabId: number): PendingAction | undefined {
  return loadPending(sessionName).find(p => p.tabId === tabId);
}

export function clearAll(sessionName: string): void {
  savePending(sessionName, []);
}

export function saveRequest(sessionName: string, request: UserActionRequest): void {
  const path = requestPath(sessionName);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteJSON(path, request);
}

export function loadRequest(sessionName: string): UserActionRequest | undefined {
  return loadJSON<UserActionRequest>(requestPath(sessionName));
}

export function clearRequest(sessionName: string): void {
  safeUnlink(requestPath(sessionName));
}

export function updateRequest(sessionName: string, updates: Partial<UserActionRequest>): UserActionRequest | undefined {
  const current = loadRequest(sessionName);
  if (!current) return undefined;
  const next = { ...current, ...updates };
  saveRequest(sessionName, next);
  return next;
}

export function saveResponse(sessionName: string, response: UserActionResponse): void {
  const path = responsePath(sessionName);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteJSON(path, response);
}

export function loadResponse(sessionName: string): UserActionResponse | undefined {
  return loadJSON<UserActionResponse>(responsePath(sessionName));
}

export function clearResponse(sessionName: string): void {
  safeUnlink(responsePath(sessionName));
}

// Simple file lock (self-contained, no core dependency)
function simpleLock(lockPath: string): void {
  const maxRetries = 20;
  for (let i = 0; i < maxRetries; i++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return;
    } catch {
      // Lock exists — check if owner is still alive
      try {
        const ownerPid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
        if (ownerPid && ownerPid !== process.pid) {
          try { process.kill(ownerPid, 0); } catch {
            // Owner dead — stale lock, safe to take
            try { unlinkSync(lockPath); } catch {}
            continue;
          }
        }
      } catch {}
      const sleep = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end); };
      sleep(50);
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

function simpleUnlock(lockPath: string): void {
  try {
    // Only release if we own the lock
    const ownerPid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
    if (!ownerPid || ownerPid === process.pid) {
      safeUnlink(lockPath);
    }
  } catch {}
}

function atomicWriteJSON(filePath: string, data: unknown): void {
  const tmp = join(dirname(filePath), `.tmp-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  safeUnlink(filePath);
  renameSync(tmp, filePath);
}

function loadJSON<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

function safeUnlink(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {}
}

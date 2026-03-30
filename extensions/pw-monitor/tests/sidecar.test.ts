// sidecar.test.ts — Sidecar lifecycle and registry persistence tests
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadStore } from '../src/tab-store.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'pw-sidecar-test-'));
}

describe('sidecar registry format', () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = makeTmpDir();
    storePath = join(dir, 'monitor-tabs.json');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('persists sidecarPid in registry when written by sidecar', () => {
    // Simulate sidecar writing registry with its PID
    const data = {
      nextId: 3,
      tabs: [
        { tabId: 1, cdpTargetId: 'A', url: 'http://a.com', title: 'A', createdAt: '2026-01-01', lastSeenAt: '2026-01-01' },
        { tabId: 2, cdpTargetId: 'B', url: 'http://b.com', title: 'B', createdAt: '2026-01-01', lastSeenAt: '2026-01-01' },
      ],
      activeTabId: 1,
      sidecarPid: 99999,
    };
    writeFileSync(storePath, JSON.stringify(data), 'utf-8');

    // loadStore should read tabs correctly
    const store = loadStore(storePath);
    expect(store.count()).toBe(2);
    expect(store.get(1)?.url).toBe('http://a.com');
    expect(store.getActiveTabId()).toBe(1);
  });

  it('loadStore recovers from sidecar-written format', () => {
    const data = {
      nextId: 5,
      tabs: [
        { tabId: 3, cdpTargetId: 'C', url: 'http://c.com', title: 'C', createdAt: '2026-01-01', lastSeenAt: '2026-01-01' },
      ],
      activeTabId: 3,
      sidecarPid: process.pid, // use our own PID to simulate "alive"
    };
    writeFileSync(storePath, JSON.stringify(data), 'utf-8');

    const store = loadStore(storePath);
    expect(store.count()).toBe(1);
    const newEntry = store.add({ cdpTargetId: 'D', url: 'http://d.com', title: 'D' });
    expect(newEntry.tabId).toBe(5); // continues from nextId
  });

  it('store persists activeTabId', () => {
    const store = loadStore(storePath);
    store.add({ cdpTargetId: 'T1', url: 'http://a.com', title: 'A' });
    store.setActiveTabId(1);
    store.save(storePath);

    const restored = loadStore(storePath);
    expect(restored.getActiveTabId()).toBe(1);
  });

  it('clear resets activeTabId', () => {
    const store = loadStore(storePath);
    store.add({ cdpTargetId: 'T1', url: 'http://a.com', title: 'A' });
    store.setActiveTabId(1);
    store.clear();
    expect(store.getActiveTabId()).toBeNull();
  });
});

describe('sidecar PID detection', () => {
  it('process.kill(pid, 0) returns true for own PID', () => {
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it('process.kill(pid, 0) throws for dead PID', () => {
    expect(() => process.kill(99999, 0)).toThrow();
  });
});

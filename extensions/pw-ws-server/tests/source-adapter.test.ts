// source-adapter.test.ts — Tests for pw-monitor source adapter
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pwMonitorAdapter } from '../src/sources/pw-monitor.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

const TEST_SESSION = `__test-ws-${Date.now()}`;
const sessDir = join(homedir(), '.playwright-state', 'sessions', TEST_SESSION);

beforeEach(() => {
  mkdirSync(sessDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(sessDir, { recursive: true, force: true }); } catch {}
});

describe('pwMonitorAdapter', () => {
  it('returns empty snapshot when no files exist', () => {
    const snap = pwMonitorAdapter.readSnapshot(TEST_SESSION);
    expect(snap.session).toBeNull();
    expect(snap.tabs).toEqual([]);
    expect(snap.activeTabId).toBeNull();
    expect(snap.pendingActions).toEqual([]);
  });

  it('reads monitor-tabs.json', () => {
    writeFileSync(join(sessDir, 'monitor-tabs.json'), JSON.stringify({
      nextId: 3,
      tabs: [
        { tabId: 1, cdpTargetId: 'A', url: 'http://a.com', title: 'A', createdAt: '2026-01-01', lastSeenAt: '2026-01-01' },
        { tabId: 2, cdpTargetId: 'B', url: 'http://b.com', title: 'B', createdAt: '2026-01-01', lastSeenAt: '2026-01-01' },
      ],
      activeTabId: 1,
      sidecarPid: 99999,
    }));

    const snap = pwMonitorAdapter.readSnapshot(TEST_SESSION);
    expect(snap.tabs).toHaveLength(2);
    expect(snap.activeTabId).toBe(1);
    expect(snap.sidecarPid).toBe(99999);
    expect(snap.sidecarAlive).toBe(false); // PID 99999 doesn't exist
  });

  it('reads session.json', () => {
    writeFileSync(join(sessDir, 'session.json'), JSON.stringify({
      name: TEST_SESSION,
      id: 'test-id',
      pid: process.pid,
      cdpEndpoint: 'ws://localhost:9222/devtools/browser/abc',
      startedAt: '2026-01-01T00:00:00Z',
    }));

    const snap = pwMonitorAdapter.readSnapshot(TEST_SESSION);
    expect(snap.session).not.toBeNull();
    expect(snap.session.name).toBe(TEST_SESSION);
    expect(snap.session.pid).toBe(process.pid);
  });

  it('reads pending-actions.json', () => {
    writeFileSync(join(sessDir, 'pending-actions.json'), JSON.stringify({
      pending: [
        { tabId: 1, prompt: 'Click continue', actions: ['continue'], createdAt: '2026-01-01' },
      ],
    }));

    const snap = pwMonitorAdapter.readSnapshot(TEST_SESSION);
    expect(snap.pendingActions).toHaveLength(1);
    expect(snap.pendingActions[0].prompt).toBe('Click continue');
  });

  it('handles corrupted files gracefully', () => {
    writeFileSync(join(sessDir, 'monitor-tabs.json'), 'NOT JSON');
    writeFileSync(join(sessDir, 'session.json'), 'BROKEN');

    const snap = pwMonitorAdapter.readSnapshot(TEST_SESSION);
    expect(snap.session).toBeNull();
    expect(snap.tabs).toEqual([]);
  });

  it('subscribe returns unsubscribe function', () => {
    const unsub = pwMonitorAdapter.subscribe(TEST_SESSION, () => {});
    expect(typeof unsub).toBe('function');
    unsub();
  });
});

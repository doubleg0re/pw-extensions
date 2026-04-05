// state.test.ts — Unit tests for pending user-action state persistence
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  addPending,
  clearAll,
  clearRequest,
  clearResponse,
  getPending,
  loadPending,
  loadRequest,
  loadResponse,
  removePending,
  savePending,
  saveRequest,
  saveResponse,
  type PendingAction,
  type UserActionRequest,
  type UserActionResponse,
} from '../src/state.js';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

// Use a temp session directory to avoid polluting real state
const TEST_SESSION = `__test-persist-${Date.now()}`;
const sessDir = join(homedir(), '.playwright-state', 'sessions', TEST_SESSION);

beforeEach(() => {
  if (!existsSync(sessDir)) mkdirSync(sessDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(sessDir, { recursive: true, force: true }); } catch {}
});

describe('state persistence', () => {
  it('returns empty array when no file exists', () => {
    expect(loadPending(TEST_SESSION)).toEqual([]);
  });

  it('saves and loads pending actions', () => {
    const action: PendingAction = {
      tabId: 1,
      prompt: 'Click continue',
      actions: ['continue'],
      createdAt: new Date().toISOString(),
    };
    savePending(TEST_SESSION, [action]);
    const loaded = loadPending(TEST_SESSION);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].tabId).toBe(1);
    expect(loaded[0].prompt).toBe('Click continue');
  });

  it('addPending replaces existing for same tabId', () => {
    addPending(TEST_SESSION, {
      tabId: 1, prompt: 'first', actions: ['ok'], createdAt: '2026-01-01T00:00:00Z',
    });
    addPending(TEST_SESSION, {
      tabId: 1, prompt: 'second', actions: ['ok'], createdAt: '2026-01-01T00:01:00Z',
    });
    const loaded = loadPending(TEST_SESSION);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].prompt).toBe('second');
  });

  it('addPending keeps different tabIds', () => {
    addPending(TEST_SESSION, {
      tabId: 1, prompt: 'tab1', actions: ['ok'], createdAt: '2026-01-01T00:00:00Z',
    });
    addPending(TEST_SESSION, {
      tabId: 2, prompt: 'tab2', actions: ['ok'], createdAt: '2026-01-01T00:00:00Z',
    });
    expect(loadPending(TEST_SESSION)).toHaveLength(2);
  });

  it('removePending removes by tabId', () => {
    addPending(TEST_SESSION, {
      tabId: 1, prompt: 'a', actions: ['ok'], createdAt: '2026-01-01T00:00:00Z',
    });
    addPending(TEST_SESSION, {
      tabId: 2, prompt: 'b', actions: ['ok'], createdAt: '2026-01-01T00:00:00Z',
    });
    removePending(TEST_SESSION, 1);
    const loaded = loadPending(TEST_SESSION);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].tabId).toBe(2);
  });

  it('getPending returns specific tabId', () => {
    addPending(TEST_SESSION, {
      tabId: 5, prompt: 'found me', actions: ['yes', 'no'], createdAt: '2026-01-01T00:00:00Z',
    });
    expect(getPending(TEST_SESSION, 5)?.prompt).toBe('found me');
    expect(getPending(TEST_SESSION, 99)).toBeUndefined();
  });

  it('clearAll removes everything', () => {
    addPending(TEST_SESSION, {
      tabId: 1, prompt: 'a', actions: ['ok'], createdAt: '2026-01-01T00:00:00Z',
    });
    addPending(TEST_SESSION, {
      tabId: 2, prompt: 'b', actions: ['ok'], createdAt: '2026-01-01T00:00:00Z',
    });
    clearAll(TEST_SESSION);
    expect(loadPending(TEST_SESSION)).toHaveLength(0);
  });

  it('handles corrupted file gracefully', () => {
    const { writeFileSync } = require('fs');
    const path = join(sessDir, 'pending-actions.json');
    writeFileSync(path, 'NOT JSON', 'utf-8');
    expect(loadPending(TEST_SESSION)).toEqual([]);
  });

  it('preserves focus field', () => {
    addPending(TEST_SESSION, {
      tabId: 1, prompt: 'focus test', actions: ['ok'], focus: '#email', createdAt: '2026-01-01T00:00:00Z',
    });
    expect(getPending(TEST_SESSION, 1)?.focus).toBe('#email');
  });

  it('preserves renderer field', () => {
    addPending(TEST_SESSION, {
      tabId: 1,
      prompt: 'native dialog',
      actions: ['approve'],
      createdAt: '2026-01-01T00:00:00Z',
      renderer: 'native-dialog',
      visible: false,
    });
    expect(getPending(TEST_SESSION, 1)?.renderer).toBe('native-dialog');
    expect(getPending(TEST_SESSION, 1)?.visible).toBe(false);
  });

  it('saves and loads dialog request files', () => {
    const request: UserActionRequest = {
      id: 'req-1',
      session: TEST_SESSION,
      tabId: 3,
      prompt: 'Approve deployment?',
      actions: ['approve', 'cancel'],
      createdAt: '2026-01-01T00:00:00Z',
      visible: false,
    };
    saveRequest(TEST_SESSION, request);
    expect(loadRequest(TEST_SESSION)).toEqual(request);
    clearRequest(TEST_SESSION);
    expect(loadRequest(TEST_SESSION)).toBeUndefined();
  });

  it('saves and loads dialog response files', () => {
    const response: UserActionResponse = {
      id: 'req-1',
      action: 'approve',
      session: TEST_SESSION,
      tabId: 3,
      submittedAt: '2026-01-01T00:00:05Z',
    };
    saveResponse(TEST_SESSION, response);
    expect(loadResponse(TEST_SESSION)).toEqual(response);
    clearResponse(TEST_SESSION);
    expect(loadResponse(TEST_SESSION)).toBeUndefined();
  });
});

// action-user-action.ts — pw-user-action custom sequence action
// Uses a native topmost dialog on Windows and falls back to browser
// overlay elsewhere. Pending state stays session-scoped for monitor UI
// and debug visibility.
//
// Usage in sequence:
//   {"action": "pw-user-action", "prompt": "Click approve", "actions": ["approve", "cancel"]}

import { addPending, removePending, updatePending } from './state.js';
import { injectOverlay, readOverlaySelection, removeOverlay } from './overlay.js';
import { canUseNativeDialog, showNativeDialog } from './native-dialog.js';
import { isTabVisible, resolveMonitorTabId } from './monitor-state.js';

export default async function(page: any, args: any, runtime?: any): Promise<{ result?: any }> {
  const prompt = args?.prompt || args?.[0] || 'Complete the action, then click Continue';
  const actions: string[] = args?.actions || args?.[1] || ['continue'];
  const focus = args?.focus;
  const idle = Number(args?.idle) || 0;
  const sessionName = runtime?.session?.name;
  const pageUrl = typeof page?.url === 'function' ? page.url() : runtime?.tab?.url;
  const tabId = resolveMonitorTabId(sessionName, pageUrl, runtime?.tab?.id ?? 0);
  const renderer = canUseNativeDialog() ? 'native-dialog' : 'browser-overlay';
  const getVisible = createVisibilityTracker(sessionName, tabId);
  const initialVisible = getVisible();

  if (renderer === 'browser-overlay') {
    const isHeadless = await page.evaluate(() => !window.outerHeight || !window.outerWidth).catch(() => true);
    if (isHeadless) {
      throw new Error('pw-user-action requires --headed when native dialog is unavailable (no visible browser window for fallback overlay)');
    }
  }

  // Persist pending state
  if (sessionName) {
    addPending(sessionName, {
      tabId,
      prompt,
      actions,
      focus,
      createdAt: new Date().toISOString(),
      renderer,
      visible: initialVisible,
    });
  }

  // Emit started event
  if (runtime?.emitEvent) {
    runtime.emitEvent('user-action:started', {
      session: sessionName,
      tabId,
      prompt,
      actions,
      focus,
      renderer,
      visible: initialVisible,
      timestamp: new Date().toISOString(),
    });
  }

  // Focus element if specified
  if (focus) {
    await page.locator(String(focus)).first().click().catch(() => {});
  }

  // Wait for idle period
  if (idle > 0) {
    await new Promise(r => setTimeout(r, idle));
  }

  let clicked: string | undefined;
  let submittedAt: string | undefined;

  try {
    if (renderer === 'native-dialog' && sessionName) {
      const response = await showNativeDialog({
        session: sessionName,
        tabId,
        prompt,
        actions,
        focus,
        visible: initialVisible,
        runtime,
        getVisible,
      });
      clicked = response.action;
      submittedAt = response.submittedAt;
    } else {
      clicked = await waitForBrowserOverlay(page, prompt, actions, getVisible);
      submittedAt = new Date().toISOString();
    }
  } finally {
    if (sessionName) {
      removePending(sessionName, tabId);
    }
    if (renderer === 'browser-overlay') {
      await removeOverlay(page).catch(() => {});
    }
  }

  // Emit completed event
  if (runtime?.emitEvent) {
    runtime.emitEvent('user-action:completed', {
      session: sessionName,
      tabId,
      action: clicked,
      renderer,
      timestamp: submittedAt || new Date().toISOString(),
    });
  }

  return {
    result: {
      waited: 'pw-user-action',
      prompt,
      action: clicked,
      renderer,
      session: sessionName,
      tabId,
      submittedAt,
    },
  };
}

async function waitForBrowserOverlay(page: any, prompt: string, actions: string[], getVisible: () => boolean): Promise<string> {
  let overlayVisible = false;

  while (true) {
    const shouldShow = getVisible();

    try {
      if (shouldShow && !overlayVisible) {
        await injectOverlay(page, prompt, actions);
        overlayVisible = true;
      } else if (!shouldShow && overlayVisible) {
        await removeOverlay(page);
        overlayVisible = false;
      }

      const clicked = await readOverlaySelection(page);
      if (clicked) {
        await removeOverlay(page).catch(() => {});
        return clicked;
      }
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('Execution context was destroyed') || msg.includes('navigation')) {
        overlayVisible = false;
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      } else {
        throw err;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

function createVisibilityTracker(sessionName: string | undefined, tabId: number): () => boolean {
  let lastVisible: boolean | undefined;

  return () => {
    const visible = isTabVisible(sessionName, tabId);
    if (sessionName && visible !== lastVisible) {
      try {
        updatePending(sessionName, tabId, { visible });
      } catch {}
    }
    lastVisible = visible;
    return visible;
  };
}

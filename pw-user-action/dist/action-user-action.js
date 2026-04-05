// action-user-action.ts — pw-user-action custom sequence action
//
// Uses a native webview dialog (Tauri/wry) when the renderer binary is
// available, otherwise falls back to a browser-injected overlay.
//
// Visibility / focus tracking is handled by pw-monitor. This action does
// not read monitor-tabs.json directly and does not touch pw-ws-server
// internals. It only depends on pw-monitor's client API.
//
// Usage in sequence:
//   {"action": "pw-user-action", "prompt": "Click approve", "actions": ["approve", "cancel"]}
import { addPending, removePending } from './state.js';
import { injectOverlay, readOverlaySelection, removeOverlay } from './overlay.js';
import { canUseNativeDialog, showNativeDialog } from './native-dialog.js';
import { subscribeMonitor } from './monitor-ws-client.js';
export default async function (page, args, runtime) {
    const prompt = args?.prompt || args?.[0] || 'Complete the action, then click Continue';
    const actions = args?.actions || args?.[1] || ['continue'];
    const title = args?.title;
    const focus = args?.focus;
    const idle = Number(args?.idle) || 0;
    const sessionName = runtime?.session?.name;
    const tabId = runtime?.tab?.id ?? 0;
    const renderer = canUseNativeDialog() ? 'native-dialog' : 'browser-overlay';
    if (renderer === 'browser-overlay') {
        const isHeadless = await page.evaluate(() => !window.outerHeight || !window.outerWidth).catch(() => true);
        if (isHeadless) {
            throw new Error('pw-user-action requires --headed when native dialog is unavailable (no visible browser window for fallback overlay)');
        }
    }
    // Persist pending state (for debug / monitor UI)
    if (sessionName) {
        addPending(sessionName, {
            tabId,
            prompt,
            actions,
            focus,
            createdAt: new Date().toISOString(),
            renderer,
            visible: true,
        });
    }
    if (runtime?.emitEvent) {
        runtime.emitEvent('user-action:started', {
            session: sessionName,
            tabId,
            prompt,
            actions,
            focus,
            renderer,
            timestamp: new Date().toISOString(),
        });
    }
    // Focus element if specified
    if (focus) {
        await page.locator(String(focus)).first().click().catch(() => { });
    }
    // Wait for idle period
    if (idle > 0) {
        await new Promise(r => setTimeout(r, idle));
    }
    let clicked;
    let submittedAt;
    try {
        if (renderer === 'native-dialog' && sessionName) {
            const response = await showNativeDialog({
                session: sessionName,
                tabId,
                prompt,
                actions,
                title,
                focus,
                runtime,
            });
            clicked = response.action;
            submittedAt = response.submittedAt;
        }
        else {
            clicked = await waitForBrowserOverlay(page, sessionName, tabId, prompt, actions);
            submittedAt = new Date().toISOString();
        }
    }
    finally {
        if (sessionName) {
            removePending(sessionName, tabId);
        }
        if (renderer === 'browser-overlay') {
            await removeOverlay(page).catch(() => { });
        }
    }
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
/**
 * Browser overlay fallback. Subscribes to pw-monitor for visibility hints
 * and re-injects/removes the overlay when the owning tab gains/loses focus.
 */
async function waitForBrowserOverlay(page, sessionName, tabId, prompt, actions) {
    let overlayVisible = false;
    let latestVisible = true;
    const computeVisible = (state) => {
        if (state.browserVisible === false)
            return false;
        if (state.browserFocused === false)
            return false;
        const active = state.activeTabId;
        if (active === null || active === undefined)
            return true;
        return active === tabId;
    };
    // Best-effort monitor subscription. If pw-monitor isn't available the
    // overlay stays permanently visible.
    let subscription = null;
    if (sessionName) {
        try {
            const sub = await subscribeMonitor(sessionName, (state) => {
                latestVisible = computeVisible(state);
            });
            latestVisible = computeVisible(sub.initial);
            subscription = sub;
        }
        catch {
            // Transport unavailable — fall through to always-visible
        }
    }
    try {
        while (true) {
            try {
                if (latestVisible && !overlayVisible) {
                    await injectOverlay(page, prompt, actions);
                    overlayVisible = true;
                }
                else if (!latestVisible && overlayVisible) {
                    await removeOverlay(page);
                    overlayVisible = false;
                }
                if (overlayVisible) {
                    const clicked = await readOverlaySelection(page);
                    if (clicked) {
                        await removeOverlay(page).catch(() => { });
                        return clicked;
                    }
                }
            }
            catch (err) {
                const msg = err?.message || '';
                if (msg.includes('Execution context was destroyed') || msg.includes('navigation')) {
                    overlayVisible = false;
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
                }
                else {
                    throw err;
                }
            }
            await new Promise(resolve => setTimeout(resolve, 150));
        }
    }
    finally {
        subscription?.close();
    }
}

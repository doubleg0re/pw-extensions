// action-user-action.ts — pw-user-action custom sequence action
// Owned by pw-persist-user-action extension. Shows overlay, waits for
// user click, survives navigation. Manages pending state lifecycle.
//
// Usage in sequence:
//   {"action": "pw-user-action", "prompt": "Click approve", "actions": ["approve", "cancel"]}

import { addPending, removePending } from './state.js';

export default async function(page: any, args: any, runtime?: any): Promise<{ result?: any }> {
  const prompt = args?.prompt || args?.[0] || 'Complete the action, then click Continue';
  const actions: string[] = args?.actions || args?.[1] || ['continue'];
  const focus = args?.focus;
  const idle = Number(args?.idle) || 0;

  // Headless guard
  const isHeadless = await page.evaluate(() => !window.outerHeight || !window.outerWidth).catch(() => true);
  if (isHeadless) {
    throw new Error('pw-user-action requires --headed (no visible browser window for user interaction)');
  }

  const sessionName = runtime?.session?.name;
  const tabId = runtime?.tab?.id ?? 0;

  // Persist pending state
  if (sessionName) {
    addPending(sessionName, {
      tabId,
      prompt,
      actions,
      focus,
      createdAt: new Date().toISOString(),
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

  // Navigation-resilient loop: inject overlay, wait for click.
  // If navigation destroys the context, wait for load and re-inject.
  const MAX_RETRIES = 20;
  let clicked: string | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Inject overlay (safe DOM construction — no innerHTML with user input)
      await page.evaluate(({ promptMsg, btns }: { promptMsg: string; btns: string[] }) => {
        document.getElementById('__pw_user_action_overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.id = '__pw_user_action_overlay';
        overlay.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999999;background:#1a1a2e;color:#fff;padding:16px 24px;border-radius:8px;font-family:system-ui;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:400px;';

        const title = document.createElement('div');
        title.style.cssText = 'font-weight:600;margin-bottom:8px;';
        title.textContent = 'Waiting for user action';
        overlay.appendChild(title);

        const promptEl = document.createElement('div');
        promptEl.style.cssText = 'color:#ccc;margin-bottom:12px;';
        promptEl.textContent = promptMsg;
        overlay.appendChild(promptEl);

        const btnContainer = document.createElement('div');
        for (const b of btns) {
          const btn = document.createElement('button');
          btn.className = '__pw_action_btn';
          btn.dataset.action = b;
          btn.style.cssText = 'background:#4f46e5;color:#fff;border:none;padding:8px 20px;border-radius:4px;cursor:pointer;font-size:14px;margin-right:8px;';
          btn.textContent = b;
          btnContainer.appendChild(btn);
        }
        overlay.appendChild(btnContainer);

        document.body.appendChild(overlay);
      }, { promptMsg: prompt, btns: actions });

      // Wait for button click
      clicked = await page.evaluate(() => {
        return new Promise<string>((resolve) => {
          document.querySelectorAll('.__pw_action_btn').forEach(btn => {
            btn.addEventListener('click', () => {
              resolve((btn as HTMLElement).dataset.action || 'continue');
            });
          });
        });
      });

      // Remove overlay
      await page.evaluate(() => {
        document.getElementById('__pw_user_action_overlay')?.remove();
      }).catch(() => {});
      break;
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.includes('Execution context was destroyed') || msg.includes('navigation')) {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        continue;
      }
      throw err;
    }
  }

  if (!clicked) {
    throw new Error('pw-user-action: overlay destroyed too many times by navigation (max retries exceeded)');
  }

  // Clear pending state
  if (sessionName) {
    removePending(sessionName, tabId);
  }

  // Emit completed event
  if (runtime?.emitEvent) {
    runtime.emitEvent('user-action:completed', {
      session: sessionName,
      tabId,
      action: clicked,
      timestamp: new Date().toISOString(),
    });
  }

  return { result: { waited: 'pw-user-action', prompt, action: clicked } };
}

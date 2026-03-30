// overlay.ts — Overlay injection script (mirrors core user-action overlay)
// This is a standalone function that can be called by event handlers
// to re-inject the overlay after navigation.

/** Inject the user-action overlay into a page. Returns a cleanup function. */
export async function injectOverlay(
  page: any,
  prompt: string,
  actions: string[],
): Promise<void> {
  // Remove existing overlay if present
  await page.evaluate(() => {
    document.getElementById('__pw_user_action_overlay')?.remove();
  }).catch(() => {});

  // Inject overlay with action buttons (same style as core)
  await page.evaluate(({ promptMsg, btns }: { promptMsg: string; btns: string[] }) => {
    const overlay = document.createElement('div');
    overlay.id = '__pw_user_action_overlay';
    overlay.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999999;background:#1a1a2e;color:#fff;padding:16px 24px;border-radius:8px;font-family:system-ui;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:400px;';

    const buttonsHtml = btns.map(b =>
      `<button class="__pw_action_btn" data-action="${b}" style="background:#4f46e5;color:#fff;border:none;padding:8px 20px;border-radius:4px;cursor:pointer;font-size:14px;margin-right:8px;">${b}</button>`
    ).join('');

    overlay.innerHTML = `
      <div style="font-weight:600;margin-bottom:8px;">Waiting for user action</div>
      <div style="color:#ccc;margin-bottom:12px;">${promptMsg}</div>
      <div>${buttonsHtml}</div>
    `;
    document.body.appendChild(overlay);
  }, { promptMsg: prompt, btns: actions });
}

/** Wait for any action button click in the overlay. Returns the clicked action name. */
export async function waitForClick(page: any): Promise<string> {
  return page.evaluate(() => {
    return new Promise<string>((resolve) => {
      document.querySelectorAll('.__pw_action_btn').forEach(btn => {
        btn.addEventListener('click', () => {
          resolve((btn as HTMLElement).dataset.action || 'continue');
        });
      });
    });
  });
}

/** Remove the overlay from the page */
export async function removeOverlay(page: any): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('__pw_user_action_overlay')?.remove();
  }).catch(() => {});
}

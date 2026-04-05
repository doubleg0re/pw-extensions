// on-navigated.ts — Event handler for tab:navigated
// When a tab navigates and has a pending browser-overlay user-action,
// re-inject the overlay.
import { getPending } from './state.js';
import { injectOverlay } from './overlay.js';

export default async (payload: any, ctx?: any) => {
  const { session, tabId } = payload;
  if (!session || tabId == null) return;

  const pending = getPending(session, tabId);
  if (!pending) return;
  if (pending.renderer && pending.renderer !== 'browser-overlay') return;
  if (pending.visible === false) return;

  // Need the page to re-inject — get it from runtime context
  const page = ctx?.getPage ? await ctx.getPage() : ctx?.page;
  if (!page) return;

  try {
    // Wait for page to be ready after navigation
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await injectOverlay(page, pending.prompt, pending.actions);
    ctx?.logger?.info(`re-injected overlay on tab ${tabId} after navigation`);
  } catch (err: any) {
    ctx?.logger?.warn(`failed to re-inject overlay on tab ${tabId}: ${err.message}`);
  }
};

// on-deactivated.ts — Event handler for tab:deactivated
// Hides the pending prompt while another tab is active.
import { getPending, loadRequest, updatePending, updateRequest } from './state.js';
import { removeOverlay } from './overlay.js';

export default async (payload: any, ctx?: any) => {
  const { session, tabId } = payload;
  if (!session || tabId == null) return;

  const pending = getPending(session, tabId);
  if (!pending) return;

  if (pending.visible !== false) {
    updatePending(session, tabId, { visible: false });
  }

  const request = loadRequest(session);
  if (request?.tabId === tabId && request.visible !== false) {
    updateRequest(session, { visible: false });
  }

  if (pending.renderer && pending.renderer !== 'browser-overlay') return;

  const page = ctx?.getPage ? await ctx.getPage() : ctx?.page;
  if (!page) return;

  try {
    await removeOverlay(page);
    ctx?.logger?.info(`hid pending overlay on deactivated tab ${tabId}`);
  } catch (err: any) {
    ctx?.logger?.warn(`failed to hide overlay on deactivated tab ${tabId}: ${err.message}`);
  }
};

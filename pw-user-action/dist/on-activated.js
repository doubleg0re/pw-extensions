// on-activated.ts — Event handler for tab:activated
// Marks the pending prompt visible again and restores the browser overlay.
import { getPending, loadRequest, updatePending, updateRequest } from './state.js';
import { injectOverlay } from './overlay.js';
export default async (payload, ctx) => {
    const { session, tabId } = payload;
    if (!session || tabId == null)
        return;
    const pending = getPending(session, tabId);
    if (!pending)
        return;
    if (pending.visible !== true) {
        updatePending(session, tabId, { visible: true });
    }
    const request = loadRequest(session);
    if (request?.tabId === tabId && request.visible !== true) {
        updateRequest(session, { visible: true });
    }
    if (pending.renderer && pending.renderer !== 'browser-overlay')
        return;
    const page = ctx?.getPage ? await ctx.getPage() : ctx?.page;
    if (!page)
        return;
    try {
        await injectOverlay(page, pending.prompt, pending.actions);
        ctx?.logger?.info(`restored pending overlay on activated tab ${tabId}`);
    }
    catch (err) {
        ctx?.logger?.warn(`failed to restore overlay on activated tab ${tabId}: ${err.message}`);
    }
};

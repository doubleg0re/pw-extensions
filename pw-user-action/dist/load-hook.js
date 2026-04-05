// load-hook.ts — Load hook for pw-user-action
// On each command start, check if the current tab has a pending browser-overlay
// user-action and re-inject it if needed.
import { getPending } from './state.js';
import { injectOverlay } from './overlay.js';
export default async (ctx) => {
    const session = ctx.session?.name;
    if (!session)
        return;
    const tabId = ctx.tab?.id;
    if (tabId == null)
        return;
    const pending = getPending(session, tabId);
    if (!pending)
        return;
    if (pending.renderer && pending.renderer !== 'browser-overlay')
        return;
    if (pending.visible === false)
        return;
    const page = ctx.getPage ? await ctx.getPage() : ctx.page;
    if (!page)
        return;
    try {
        await injectOverlay(page, pending.prompt, pending.actions);
        ctx.logger.info(`restored pending overlay on tab ${tabId}`);
    }
    catch (err) {
        ctx.logger.warn(`failed to restore overlay on tab ${tabId}: ${err.message}`);
    }
};

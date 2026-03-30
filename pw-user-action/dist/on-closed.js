// on-closed.ts — Event handler for tab:closed
// Clean up pending user-action state when a tab is closed.
import { removePending } from './state.js';
export default async (payload) => {
    const { session, tabId } = payload;
    if (!session || tabId == null)
        return;
    removePending(session, tabId);
};

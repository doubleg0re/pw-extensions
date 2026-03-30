// on-completed.ts — Event handler for user-action:completed
// Clear pending state when the user completes the action.
import { removePending } from './state.js';
export default async (payload) => {
    const { session, tabId } = payload;
    if (!session || tabId == null)
        return;
    removePending(session, tabId);
};

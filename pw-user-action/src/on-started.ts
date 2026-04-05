// on-started.ts — Event handler for user-action:started
// Persist pending action state so it can be restored after navigation.
import { addPending } from './state.js';

export default async (payload: any) => {
  const { session, tabId, prompt, actions, focus, renderer, visible } = payload;
  if (!session || tabId == null) return;

  addPending(session, {
    tabId,
    prompt: prompt || 'Complete the action, then click Continue',
    actions: actions || ['continue'],
    focus,
    createdAt: new Date().toISOString(),
    renderer: renderer || 'browser-overlay',
    visible,
  });
};

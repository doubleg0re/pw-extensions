// Mirror of core TAB_EVENTS from tab-registry.ts — must stay in sync.
// pw-monitor cannot import core directly (toybox copy), so we duplicate
// the contract here. Payload validation tests enforce consistency.
export const TAB_EVENTS = {
    CREATED: 'tab:created',
    CLOSED: 'tab:closed',
    NAVIGATED: 'tab:navigated',
    ACTIVATED: 'tab:activated',
    DEACTIVATED: 'tab:deactivated',
};
export const BROWSER_EVENTS = {
    FOCUSED: 'browser:focused',
    BLURRED: 'browser:blurred',
    VISIBLE: 'browser:visible',
    HIDDEN: 'browser:hidden',
};
/**
 * Sync the tab store against live CDP targets.
 *
 * Strategy:
 * 1. Match persisted entries to live targets (by cdpTargetId, fallback by URL)
 * 2. Remove zombies (persisted but not in live targets) → tab:closed
 * 3. Detect navigation (matched but URL changed) → tab:navigated
 * 4. Add new targets (live but not in registry) → tab:created
 * 5. Update lastSeenAt for all matched entries
 *
 * Returns the list of events to emit.
 */
export function syncTabs(store, liveTargets, sessionName) {
    const events = [];
    const now = new Date().toISOString();
    const matched = new Set(); // tabIds that matched a live target
    const claimed = new Set(); // cdpTargetIds that were matched
    // Pass 1: Match existing entries to live targets
    for (const entry of store.all()) {
        const target = findMatch(entry, liveTargets, claimed);
        if (target) {
            claimed.add(target.cdpTargetId);
            matched.add(entry.tabId);
            // Detect navigation
            if (entry.url !== target.url) {
                events.push(buildEvent(TAB_EVENTS.NAVIGATED, sessionName, entry.tabId, target.url, target.title, now));
            }
            // Update entry with latest state
            store.update(entry.tabId, {
                cdpTargetId: target.cdpTargetId,
                url: target.url,
                title: target.title,
                lastSeenAt: now,
            });
        }
    }
    // Pass 2: Remove zombies (persisted but not matched)
    for (const entry of store.all()) {
        if (!matched.has(entry.tabId)) {
            events.push(buildEvent(TAB_EVENTS.CLOSED, sessionName, entry.tabId, entry.url, entry.title, now));
            store.remove(entry.tabId);
        }
    }
    // Pass 3: Add new targets (live but not claimed)
    for (const target of liveTargets) {
        if (!claimed.has(target.cdpTargetId)) {
            const newEntry = store.add({
                cdpTargetId: target.cdpTargetId,
                url: target.url,
                title: target.title,
            });
            events.push(buildEvent(TAB_EVENTS.CREATED, sessionName, newEntry.tabId, target.url, target.title, now));
        }
    }
    // Pass 4: Detect active tab change (best-effort — CDP /json first target = active)
    if (liveTargets.length > 0) {
        const topTarget = liveTargets[0];
        const topEntry = store.findByCdpId(topTarget.cdpTargetId);
        const newActiveId = topEntry?.tabId ?? null;
        const prevActiveId = store.getActiveTabId();
        if (newActiveId !== prevActiveId) {
            // Deactivate previous
            if (prevActiveId != null) {
                const prevEntry = store.get(prevActiveId);
                if (prevEntry) {
                    events.push(buildEvent(TAB_EVENTS.DEACTIVATED, sessionName, prevActiveId, prevEntry.url, prevEntry.title, now));
                }
            }
            // Activate new
            if (newActiveId != null && topEntry) {
                events.push(buildEvent(TAB_EVENTS.ACTIVATED, sessionName, newActiveId, topEntry.url, topEntry.title, now));
            }
            store.setActiveTabId(newActiveId);
        }
    }
    return events;
}
/** Match a persisted entry to a live target. Primary: cdpTargetId, fallback: URL */
function findMatch(entry, targets, claimed) {
    // Primary: match by cdpTargetId
    const byId = targets.find(t => t.cdpTargetId === entry.cdpTargetId && !claimed.has(t.cdpTargetId));
    if (byId)
        return byId;
    // Fallback: match by URL (CDP target IDs change on browser restart)
    const byUrl = targets.find(t => t.url === entry.url && !claimed.has(t.cdpTargetId));
    return byUrl;
}
function buildEvent(event, session, tabId, url, title, timestamp) {
    return {
        event,
        payload: { event, session, tabId, url, title, timestamp },
    };
}

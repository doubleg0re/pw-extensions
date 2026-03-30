// cdp-targets.ts — Fetch live browser targets via CDP HTTP API
/** Extract CDP port from endpoint URL (e.g., ws://localhost:9222/devtools/browser/...) */
export function extractCdpPort(cdpEndpoint) {
    if (!cdpEndpoint)
        return null;
    const match = cdpEndpoint.match(/:(\d+)\//);
    return match ? parseInt(match[1], 10) : null;
}
/** Fetch all page-type targets from a CDP endpoint */
export async function fetchTargets(port) {
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    const targets = await res.json();
    return targets
        .filter(t => t.type === 'page')
        .map(t => ({
        cdpTargetId: t.id,
        url: t.url,
        title: t.title,
    }));
}

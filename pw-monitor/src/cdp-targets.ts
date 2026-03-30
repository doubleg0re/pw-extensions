// cdp-targets.ts — Fetch live browser targets via CDP HTTP API

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface PageTarget {
  cdpTargetId: string;
  url: string;
  title: string;
}

/** Extract CDP port from endpoint URL (e.g., ws://localhost:9222/devtools/browser/...) */
export function extractCdpPort(cdpEndpoint?: string): number | null {
  if (!cdpEndpoint) return null;
  const match = cdpEndpoint.match(/:(\d+)\//);
  return match ? parseInt(match[1], 10) : null;
}

/** Fetch all page-type targets from a CDP endpoint */
export async function fetchTargets(port: number): Promise<PageTarget[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  const targets: CdpTarget[] = await res.json();
  return targets
    .filter(t => t.type === 'page')
    .map(t => ({
      cdpTargetId: t.id,
      url: t.url,
      title: t.title,
    }));
}

// provider-loader.ts — discovers and loads TransportProviders from active
// rary extensions. Extensions declare providers via extension.provides.protocols
// in their larry.json. This module scans those declarations at server startup
// and returns the loaded provider instances.
//
// pw-ws-server itself is domain-agnostic — it does not hardcode any protocol.

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { pathToFileURL } from 'url';

export interface LoadedProvider {
  /** Protocol identifier, e.g. "pw-monitor/v1" */
  channel: string;
  /** Extension that provides this channel */
  packageName: string;
  /** readSnapshot(sessionName) → initial state */
  readSnapshot: (sessionName: string) => unknown;
  /** subscribe(sessionName, emit) → unsubscribe fn */
  subscribe: (sessionName: string, emit: (snapshot: unknown) => void) => () => void;
}

interface ExtensionEntry {
  package: string;
  activatedAt: string;
}

interface LarryProvidesDef {
  transport?: string;
  entry: string;
}

interface LarryManifest {
  name: string;
  type?: string;
  extension?: {
    provides?: {
      protocols?: Record<string, LarryProvidesDef>;
    };
  };
}

function toyboxDir(): string {
  return join(homedir(), '.playwright-state', 'toybox');
}

function extensionsFilePath(): string {
  return join(homedir(), '.playwright-state', 'extensions.json');
}

function readActiveExtensions(): string[] {
  const path = extensionsFilePath();
  if (!existsSync(path)) return [];
  try {
    const data: Record<string, ExtensionEntry> = JSON.parse(readFileSync(path, 'utf-8'));
    return Object.keys(data);
  } catch {
    return [];
  }
}

function readManifest(packageName: string): LarryManifest | null {
  const file = join(toyboxDir(), packageName, 'larry.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Scan active extensions for provided protocols and dynamically import
 * each provider module.
 *
 * Returns the loaded providers keyed by channel. If multiple extensions
 * provide the same channel, the last one wins (with a warning).
 */
export async function loadProviders(transport: string): Promise<{
  providers: Map<string, LoadedProvider>;
  warnings: string[];
}> {
  const providers = new Map<string, LoadedProvider>();
  const warnings: string[] = [];

  const activeNames = readActiveExtensions();
  for (const pkgName of activeNames) {
    const manifest = readManifest(pkgName);
    const protocols = manifest?.extension?.provides?.protocols;
    if (!protocols) continue;

    for (const [channel, def] of Object.entries(protocols)) {
      if (def.transport && def.transport !== transport) {
        continue; // provider for a different transport
      }
      const entryPath = join(toyboxDir(), pkgName, def.entry);
      if (!existsSync(entryPath)) {
        warnings.push(`[${pkgName}] provider entry missing: ${def.entry}`);
        continue;
      }
      try {
        const mod = await import(pathToFileURL(entryPath).href);
        const impl = mod.default || mod;
        if (!impl || typeof impl.subscribe !== 'function' || typeof impl.readSnapshot !== 'function') {
          warnings.push(`[${pkgName}] provider "${channel}" does not export readSnapshot/subscribe`);
          continue;
        }
        if (providers.has(channel)) {
          warnings.push(`Channel "${channel}" is provided by multiple packages; "${pkgName}" overrides earlier registration`);
        }
        providers.set(channel, {
          channel,
          packageName: pkgName,
          readSnapshot: impl.readSnapshot.bind(impl),
          subscribe: impl.subscribe.bind(impl),
        });
      } catch (err: any) {
        warnings.push(`[${pkgName}] failed to load provider "${channel}": ${err?.message || String(err)}`);
      }
    }
  }

  return { providers, warnings };
}

/* What this extension keeps in chrome.storage.local: the server address, the device (its name
   and its credential, which is never shown), the shared rules it last fetched, and saves that
   are waiting. Nothing of what the user saved comes back from the core, so nothing of it is here. */
import { serverOrigin } from './items.ts';
import type { Meta, PendingSave } from './types.ts';

declare const KE_DEFAULT_SERVER: string;

/** `https://keepessence.app`; a test build points at a core on this machine instead. */
export const DEFAULT_SERVER: string = KE_DEFAULT_SERVER;

export interface Stored {
  server?: string;
  credential?: string;
  device?: { id: string; name: string };
  deviceName?: string;
  meta?: { server: string; at: number; meta: Meta };
  queue?: PendingSave[];
}

export const read = <K extends keyof Stored>(...keys: K[]) => chrome.storage.local.get(keys) as Promise<Pick<Stored, K>>;
export const write = (o: Partial<Stored>) => chrome.storage.local.set(o);
export const remove = (...keys: (keyof Stored)[]) => chrome.storage.local.remove(keys);

export async function serverAddress(): Promise<string> {
  const { server } = await read('server');
  return serverOrigin(server) ?? DEFAULT_SERVER;
}

export const originPattern = (server: string) => `${server.replace(/:\d+$/, '')}/*`;

export async function mayReach(server: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(server)] });
  } catch {
    return false;
  }
}

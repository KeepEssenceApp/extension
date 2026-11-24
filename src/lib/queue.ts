/* Saves that have not reached the core yet: the browser was offline, or it is not connected.
   Pure: the caller keeps the list in chrome.storage.local. */
import type { PendingSave } from './types.ts';

export const QUEUE_MAX_ITEMS = 100;
/** chrome.storage.local holds about 10 MB; leave room for the rest. */
export const QUEUE_MAX_CHARS = 6 * 1024 * 1024;

export function sizeOf(e: PendingSave): number {
  return (e.request.text?.length ?? 0) + (e.request.url?.length ?? 0) + (e.request.title?.length ?? 0) + (e.image?.base64.length ?? 0) + 200;
}

/** Adds one save. The same key twice is one save. `ok: false` means there is no room. */
export function enqueue(queue: PendingSave[], entry: PendingSave): { queue: PendingSave[]; ok: boolean } {
  if (queue.some((e) => e.key === entry.key)) return { queue, ok: true };
  const total = queue.reduce((n, e) => n + sizeOf(e), 0) + sizeOf(entry);
  if (queue.length >= QUEUE_MAX_ITEMS || total > QUEUE_MAX_CHARS) return { queue, ok: false };
  return { queue: [...queue, entry], ok: true };
}

export type SendOutcome =
  | { kind: 'done' } //          the core answered: saved or duplicate
  | { kind: 'later' } //         no answer, or the core is busy: keep it and stop for now
  | { kind: 'unauthorized' } //  the device was revoked: keep it and stop
  | { kind: 'rejected'; reason: string }; // the core will never take it: drop it and say why

export interface FlushReport {
  remaining: PendingSave[];
  sent: number;
  rejected: { entry: PendingSave; reason: string }[];
  stopped: 'empty' | 'later' | 'unauthorized';
}

/** Sends the queue oldest first. Stops at the first save that cannot go out now, so order is kept. */
export async function flush(queue: PendingSave[], send: (e: PendingSave) => Promise<SendOutcome>): Promise<FlushReport> {
  const report: FlushReport = { remaining: [], sent: 0, rejected: [], stopped: 'empty' };
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i]!;
    const out = await send(entry);
    if (out.kind === 'done') report.sent++;
    else if (out.kind === 'rejected') report.rejected.push({ entry, reason: out.reason });
    else {
      report.remaining = queue.slice(i);
      report.stopped = out.kind;
      return report;
    }
  }
  return report;
}

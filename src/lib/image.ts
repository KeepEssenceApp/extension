/* An image on its way to the asset flow: WebP, long edge at most `image_long_edge_px`,
   hashed with SHA-256. Runs in the service worker (OffscreenCanvas). */
import type { PreparedImage } from './types.ts';

export function scaled(width: number, height: number, longEdge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= longEdge || long === 0) return { width, height };
  const k = longEdge / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type Prepared = { ok: true; image: PreparedImage } | { ok: false; why: 'unreadable' | 'too_large' };

export async function prepareImage(source: Blob, longEdge: number, maxBytes: number): Promise<Prepared> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return { ok: false, why: 'unreadable' };
  }
  const size = scaled(bitmap.width, bitmap.height, longEdge);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, why: 'unreadable' };
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (blob.type !== 'image/webp') return { ok: false, why: 'unreadable' };
    if (blob.size > maxBytes) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { ok: true, image: { base64: toBase64(bytes), sha256: await sha256Hex(bytes), bytes: bytes.length, content_type: 'image/webp' } };
  }
  return { ok: false, why: 'too_large' };
}

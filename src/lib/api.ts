/* The contract's operations this client uses, and nothing else:
   GET /v1/meta, POST /v1/device-codes, GET /v1/device-codes/{code}, POST /v1/items,
   POST /v1/assets, PUT upload_url, POST /v1/assets/{id}/complete, GET and DELETE /v1/devices/me. */
import type { Device, DeviceCode, DeviceGrant, Lang, Meta, SaveRequest, SaveResult } from './types.ts';

const TIMEOUT_MS = 20000;

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; message: string } // the core answered with an error
  | { ok: false; status: 0; code: 'network'; message: '' }; //      nothing came back

export interface Conn {
  server: string;
  lang: Lang;
  credential?: string;
}

async function call<T>(conn: Conn, method: string, pathOrUrl: string, opts: { bearer?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'Accept-Language': conn.lang, ...opts.headers };
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : conn.server + pathOrUrl;
  let r: Response;
  try {
    /* without the browser's cookies: this browser is known to the core by its device credential alone */
    r = await fetch(url, { method, headers, body, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { ok: false, status: 0, code: 'network', message: '' };
  }
  const data = (await r.json().catch(() => null)) as unknown;
  if (r.ok) return { ok: true, status: r.status, data: data as T };
  const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
  return { ok: false, status: r.status, code: err?.code ?? '', message: err?.message ?? '' };
}

export const getMeta = (c: Conn) => call<Meta>(c, 'GET', '/v1/meta');

export const createDeviceCode = (c: Conn, deviceName: string) =>
  call<DeviceCode>(c, 'POST', '/v1/device-codes', { json: { device_name: deviceName, client: 'extension', requested_tier: 'save' } });

export const pollDeviceCode = (c: Conn, code: string, pollSecret: string) =>
  call<{ status: 'pending' | 'approved' | 'denied'; grant?: DeviceGrant }>(c, 'GET', `/v1/device-codes/${encodeURIComponent(code)}`, { bearer: pollSecret });

export const getThisDevice = (c: Conn) => call<{ device: Device }>(c, 'GET', '/v1/devices/me', { bearer: c.credential });

export const revokeThisDevice = (c: Conn) => call<null>(c, 'DELETE', '/v1/devices/me', { bearer: c.credential });

export const saveItem = (c: Conn, request: SaveRequest, idempotencyKey: string) =>
  call<SaveResult>(c, 'POST', '/v1/items', { bearer: c.credential, json: request, headers: { 'Idempotency-Key': idempotencyKey } });

export interface UploadTicket {
  asset_id: string;
  status: 'stored' | 'upload' | 'over_quota';
  upload_url?: string;
}

export const requestUpload = (c: Conn, sha256: string, bytes: number, contentType: string) =>
  call<UploadTicket>(c, 'POST', '/v1/assets', { bearer: c.credential, json: { sha256, bytes, content_type: contentType } });

/** The upload address is signed by the core and carries its own leave; the credential is not sent to it. */
export const uploadBytes = (c: Conn, uploadUrl: string, bytes: Blob, contentType: string) =>
  call<null>(c, 'PUT', new URL(uploadUrl, c.server).href, { body: bytes, headers: { 'Content-Type': contentType } });

export const completeUpload = (c: Conn, assetId: string) =>
  call<null>(c, 'POST', `/v1/assets/${encodeURIComponent(assetId)}/complete`, { bearer: c.credential });

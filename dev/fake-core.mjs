/* A small fake of the handful of contract operations the extension uses, for development and
   for the tests while the real core is not running. Everything is in memory.

     node dev/fake-core.mjs            → http://127.0.0.1:8794

   It reads the limits and the shared rules from contract/openapi.yaml, so GET /v1/meta answers
   what a real core answers. A manage device exists from the start (credential printed below);
   the page at approve_url lets you press Allow by hand.

   What it implements: GET /v1/meta; POST /v1/device-codes; GET /v1/device-codes/{code};
   GET …/request, POST …/approve, POST …/deny (manage); GET, DELETE /v1/devices/me;
   POST /v1/items; GET /v1/items, GET /v1/items/{id} (read tier, so a save-only device gets 403);
   POST /v1/assets, PUT upload_url, POST /v1/assets/{id}/complete, GET /v1/assets/{id} (read). */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
export const MANAGE_CREDENTIAL = 'fake-manage-credential';
const SAVE_FIELDS = new Set(['kind', 'url', 'title', 'text', 'asset_id', 'entry']);
const ERRORS = {
  unauthorized: { zh: '这个设备没有接入，或者已被撤销。', en: 'This device is not connected, or it was revoked.' },
  forbidden: { zh: '这个设备的权限不够。', en: "This device's tier does not allow this." },
  not_found: { zh: '没有这样东西。', en: 'No such thing.' },
  gone: { zh: '短码过期了，或者已经用过。', en: 'The code expired or was already used.' },
  bad_request: { zh: '请求不对。', en: 'The request is malformed.' },
  idempotency_key_required: { zh: '缺少 Idempotency-Key。', en: 'The Idempotency-Key header is missing.' },
  too_large: { zh: '文件太大。', en: 'The file is too large.' },
  unsupported_type: { zh: '不支持这种文件。', en: 'This file type is not supported.' },
  conflict: { zh: '上传的内容和登记的不一样。', en: 'The upload does not match what was announced.' },
};

/** Width and height of a WebP, for the three ways the header can be written. null: not a WebP. */
export function webpSize(b) {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

export function createFakeCore({ contractPath = join(here, '../contract/openapi.yaml') } = {}) {
  const contract = parse(readFileSync(contractPath, 'utf8'));
  const limits = contract['x-limits'];
  const rules = contract['x-shared-rules'];
  const state = {
    devices: new Map(), //   credential → device
    codes: new Map(), //     code → { poll_secret, device_name, client, requested_tier, expires_at, status, grant, taken }
    items: [], //            { id, request, created_at, entry }
    idempotency: new Map(), // credential + key → { status, body }
    assets: new Map(), //    id → { sha256, bytes, content_type, data, stored }
    requests: [], //         every request, for the tests: { method, path, headers, body }
    quotaFull: false,
  };
  state.devices.set(MANAGE_CREDENTIAL, { id: 'dev_manage', name: 'Fake manage device', category: 'client', client: 'web', tier: 'manage', created_at: new Date().toISOString(), last_used_at: null });
  let base = '';

  const langOf = (req) => (/^zh/i.test(req.headers['accept-language'] || '') ? 'zh' : 'en');
  const send = (res, status, body, headers = {}) => {
    const data = body === undefined ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(data);
  };
  const fail = (req, res, status, code) => send(res, status, { error: { code, message: ERRORS[code]?.[langOf(req)] ?? code } });
  const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  const tierAtLeast = (device, tier) => ['save', 'read', 'manage'].indexOf(device.tier) >= ['save', 'read', 'manage'].indexOf(tier);
  /** the calling device, or null after answering 401 / 403 */
  const device = (req, res, tier) => {
    const d = state.devices.get(bearer(req));
    if (!d) return fail(req, res, 401, 'unauthorized'), null;
    if (!tierAtLeast(d, tier)) return fail(req, res, 403, 'forbidden'), null;
    d.last_used_at = new Date().toISOString();
    return d;
  };
  const message = (key, lang) => rules.save_messages[key][lang];
  const result = (status, key, lang, extra = {}) => ({ status, message_key: key, message: message(key, lang), ...extra });
  const newCode = () => {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const pick = (n) => Array.from(randomBytes(n), (b) => abc[b % abc.length]).join('');
    return `${pick(3)}-${pick(3)}`;
  };
  const liveCode = (req, res, code) => {
    const c = state.codes.get(code);
    if (!c) return fail(req, res, 404, 'not_found'), null;
    if (Date.parse(c.expires_at) < Date.now() || c.taken) return fail(req, res, 410, 'gone'), null;
    return c;
  };

  async function handle(req, res) {
    const url = new URL(req.url, base);
    const path = url.pathname;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = null;
    if (/json/.test(req.headers['content-type'] || '') && raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return fail(req, res, 400, 'bad_request');
      }
    }
    state.requests.push({ method: req.method, path, headers: req.headers, body, bytes: raw.length });
    const lang = langOf(req);
    let m;

    if (req.method === 'GET' && path === '/v1/meta') return send(res, 200, { contract_version: contract.info.version, limits, shared_rules: rules });

    /* ---- connecting */
    if (req.method === 'POST' && path === '/v1/device-codes') {
      const ok = body && typeof body.device_name === 'string' && body.device_name.length >= 1 && body.device_name.length <= 60 && ['web', 'phone', 'extension', 'shortcut', 'share', 'menubar', 'eink'].includes(body.client) && ['save', 'read', 'manage'].includes(body.requested_tier);
      if (!ok) return fail(req, res, 400, 'bad_request');
      const code = newCode();
      const c = { poll_secret: randomBytes(24).toString('base64url'), device_name: body.device_name, client: body.client, requested_tier: body.requested_tier, expires_at: new Date(Date.now() + limits.device_code_minutes * 60000).toISOString(), status: 'pending', grant: null, taken: false };
      state.codes.set(code, c);
      return send(res, 201, { code, poll_secret: c.poll_secret, expires_at: c.expires_at, approve_url: `${base}/connect?code=${encodeURIComponent(code)}` });
    }
    if ((m = /^\/v1\/device-codes\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const c = state.codes.get(decodeURIComponent(m[1]));
      if (!c || bearer(req) !== c.poll_secret) return fail(req, res, 401, 'unauthorized');
      if (Date.parse(c.expires_at) < Date.now() || c.taken) return fail(req, res, 410, 'gone');
      if (c.status === 'approved') {
        c.taken = true; // the credential is returned once
        return send(res, 200, { status: 'approved', grant: c.grant });
      }
      return send(res, 200, { status: c.status });
    }
    if ((m = /^\/v1\/device-codes\/([^/]+)\/(request|approve|deny)$/.exec(path))) {
      if (!device(req, res, 'manage')) return;
      const c = liveCode(req, res, decodeURIComponent(m[1]));
      if (!c) return;
      if (m[2] === 'request' && req.method === 'GET') return send(res, 200, { device_name: c.device_name, client: c.client, requested_tier: c.requested_tier, expires_at: c.expires_at });
      if (c.status !== 'pending') return fail(req, res, 410, 'gone');
      if (m[2] === 'deny' && req.method === 'POST') {
        c.status = 'denied';
        return send(res, 204);
      }
      if (m[2] === 'approve' && req.method === 'POST') {
        const tier = body?.tier ?? c.requested_tier;
        if (!tierAtLeast({ tier: c.requested_tier }, tier)) return fail(req, res, 400, 'bad_request'); // never above what was requested
        const credential = 'fake_' + randomBytes(24).toString('base64url');
        const d = { id: 'dev_' + randomBytes(6).toString('hex'), name: body?.device_name || c.device_name, category: 'client', client: c.client, tier, created_at: new Date().toISOString(), last_used_at: null };
        state.devices.set(credential, d);
        c.status = 'approved';
        c.grant = { credential, device: d, user: { id: 'user_1', timezone: 'Asia/Shanghai', lang: 'zh' } };
        return send(res, 200, d);
      }
    }
    if (path === '/v1/devices/me') {
      const d = device(req, res, 'save');
      if (!d) return;
      if (req.method === 'GET') return send(res, 200, { device: { ...d, this_device: true }, user: { id: 'user_1', timezone: 'Asia/Shanghai', lang: 'zh' } });
      if (req.method === 'DELETE') {
        state.devices.delete(bearer(req));
        return send(res, 204);
      }
    }

    /* ---- saving */
    if (req.method === 'POST' && path === '/v1/items') {
      const d = device(req, res, 'save');
      if (!d) return;
      const key = req.headers['idempotency-key'];
      if (!key || key.length < 8 || key.length > 128) return fail(req, res, 400, 'idempotency_key_required');
      const seen = state.idempotency.get(`${d.id} ${key}`);
      if (seen) return send(res, seen.status, seen.body); // the same key returns the first response
      const r = body;
      const valid =
        r && typeof r === 'object' && Object.keys(r).every((k) => SAVE_FIELDS.has(k)) && // additionalProperties: false — no tags, no triage
        ['link', 'text', 'image', 'file'].includes(r.kind) &&
        (r.url === undefined || (typeof r.url === 'string' && /^https?:\/\//.test(r.url) && r.url.length <= 2000)) &&
        (r.title === undefined || (typeof r.title === 'string' && r.title.length <= 300)) &&
        (r.text === undefined || (typeof r.text === 'string' && r.text.length <= limits.text_max_chars)) &&
        (r.kind !== 'link' || r.url) && (r.kind !== 'text' || r.text) && (!['image', 'file'].includes(r.kind) || r.asset_id);
      if (!valid) return fail(req, res, 400, 'bad_request');
      let answer;
      const asset = r.asset_id ? state.assets.get(r.asset_id) : null;
      if (r.asset_id && !asset) return fail(req, res, 404, 'not_found');
      const twin = r.kind === 'link' ? state.items.find((i) => i.request.kind === 'link' && i.request.url === r.url) : null;
      if (twin) answer = { status: 200, body: result('duplicate', 'duplicate', lang, { item_id: twin.id }) };
      else {
        const item = { id: 'item_' + randomBytes(6).toString('hex'), request: r, created_at: new Date().toISOString(), device_id: d.id };
        state.items.push(item);
        const stored = !asset || asset.stored;
        answer = { status: 201, body: result('saved', stored ? 'saved' : 'saved_image_skipped_quota', lang, { item_id: item.id, ...(asset ? { image_stored: stored } : {}) }) };
      }
      state.idempotency.set(`${d.id} ${key}`, answer);
      return send(res, answer.status, answer.body);
    }
    if (req.method === 'POST' && path === '/v1/assets') {
      if (!device(req, res, 'save')) return;
      const ok = body && /^[0-9a-f]{64}$/.test(body.sha256 || '') && Number.isInteger(body.bytes) && body.bytes >= 1;
      if (!ok) return fail(req, res, 400, 'bad_request');
      if (body.bytes > limits.asset_max_bytes) return fail(req, res, 413, 'too_large');
      if (!['image/webp', 'image/png', 'image/jpeg', 'image/gif', 'application/pdf', 'text/plain', 'text/markdown'].includes(body.content_type)) return fail(req, res, 415, 'unsupported_type');
      for (const [id, a] of state.assets) if (a.stored && a.sha256 === body.sha256) return send(res, 200, { asset_id: id, status: 'stored' });
      const id = 'asset_' + randomBytes(6).toString('hex');
      state.assets.set(id, { sha256: body.sha256, bytes: body.bytes, content_type: body.content_type, data: null, stored: false, sig: randomBytes(12).toString('hex') });
      if (state.quotaFull) return send(res, 200, { asset_id: id, status: 'over_quota' });
      return send(res, 200, { asset_id: id, status: 'upload', upload_url: `${base}/upload/${id}?sig=${state.assets.get(id).sig}`, expires_at: new Date(Date.now() + 600000).toISOString() });
    }
    if ((m = /^\/upload\/([^/]+)$/.exec(path)) && req.method === 'PUT') {
      const a = state.assets.get(m[1]);
      if (!a || url.searchParams.get('sig') !== a.sig) return fail(req, res, 401, 'unauthorized'); // the signature is the leave: no credential here
      if (raw.length !== a.bytes || req.headers['content-type'] !== a.content_type) return fail(req, res, 409, 'conflict');
      a.data = raw;
      return send(res, 204);
    }
    if ((m = /^\/v1\/assets\/([^/]+)\/complete$/.exec(path)) && req.method === 'POST') {
      if (!device(req, res, 'save')) return;
      const a = state.assets.get(m[1]);
      if (!a) return fail(req, res, 404, 'not_found');
      if (!a.data || a.data.length !== a.bytes || createHash('sha256').update(a.data).digest('hex') !== a.sha256) return fail(req, res, 409, 'conflict');
      if (a.content_type === 'image/webp' && !webpSize(a.data)) return fail(req, res, 415, 'unsupported_type'); // the file header is checked
      a.stored = true;
      return send(res, 204);
    }

    /* ---- reading: only so that a save-only device can be shown to get nothing, and for the tests to look */
    if (req.method === 'GET' && path === '/v1/items') {
      if (!device(req, res, 'read')) return;
      return send(res, 200, { items: state.items.map((i) => ({ id: i.id, kind: i.request.kind, title: i.request.title ?? '', url: i.request.url ?? null, created_at: i.created_at, stage: 'saved' })), next_cursor: null });
    }
    if ((m = /^\/v1\/items\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      if (!device(req, res, 'read')) return;
      const i = state.items.find((x) => x.id === m[1]);
      if (!i) return fail(req, res, 404, 'not_found');
      return send(res, 200, { id: i.id, kind: i.request.kind, title: i.request.title ?? '', url: i.request.url ?? null, created_at: i.created_at, stage: 'saved', body: i.request.text ?? null, asset_id: i.request.asset_id ?? null, tags: [] });
    }
    if ((m = /^\/v1\/assets\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      if (!device(req, res, 'read')) return;
      const a = state.assets.get(m[1]);
      if (!a?.stored) return fail(req, res, 404, 'not_found');
      return send(res, 200, a.data, { 'Content-Type': a.content_type });
    }

    /* ---- the page where a manage device presses Allow (a stand-in for the real one) */
    if (req.method === 'GET' && path === '/connect') {
      const code = url.searchParams.get('code') || '';
      const c = state.codes.get(code);
      const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
      const html = `<!doctype html><meta charset="utf-8"><title>Fake core: allow a device</title>
<body style="font:15px/1.5 system-ui;max-width:520px;margin:60px auto;padding:0 20px">
<h1 style="font-size:20px">Fake core</h1>
${c ? `<p><b>${esc(c.device_name)}</b> (${esc(c.client)}) wants to connect with the tier <b>${esc(c.requested_tier)}</b>.</p>
<p style="font-size:40px;font-weight:700;letter-spacing:.08em" id="code">${esc(code)}</p>
<button id="allow">Allow</button> <button id="refuse">Refuse</button> <span id="said"></span>
<script>
const go = (what) => fetch('/v1/device-codes/${encodeURIComponent(code)}/' + what, { method: 'POST', headers: { Authorization: 'Bearer ${MANAGE_CREDENTIAL}', 'Content-Type': 'application/json' }, body: '{}' })
  .then((r) => { document.getElementById('said').textContent = r.ok ? (what === 'approve' ? 'Allowed.' : 'Refused.') : 'Error ' + r.status; });
document.getElementById('allow').onclick = () => go('approve');
document.getElementById('refuse').onclick = () => go('deny');
</script>` : '<p>No such code.</p>'}</body>`;
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    return fail(req, res, 404, 'not_found');
  }

  const server = createServer((req, res) => void handle(req, res).catch((e) => send(res, 500, { error: { code: 'server_error', message: String(e?.message || e) } })));
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return {
    state,
    get url() {
      return base;
    },
    start: (port = 8794) =>
      new Promise((ok, no) => {
        server.once('error', no);
        server.listen(port, '127.0.0.1', () => {
          base = `http://127.0.0.1:${server.address().port}`;
          ok(base);
        });
      }),
    /** stops answering at once, as a core that cannot be reached; what it holds stays */
    stop: () =>
      new Promise((ok) => {
        for (const s of sockets) s.destroy();
        server.close(() => ok());
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const core = createFakeCore();
  const url = await core.start(Number(process.env.PORT) || 8794);
  console.log(`fake core at ${url}\nmanage credential (for tests and curl): ${MANAGE_CREDENTIAL}`);
}

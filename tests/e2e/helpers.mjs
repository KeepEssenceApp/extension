/* What the end-to-end tests stand on: a backend (the fake core, or a real core on this machine),
   a small web site to save from, and Chromium with the unpacked test build loaded. */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import { parse } from 'yaml';
import { createFakeCore, MANAGE_CREDENTIAL } from '../../dev/fake-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '../..');
export const contract = parse(readFileSync(join(root, 'contract/openapi.yaml'), 'utf8'));

/** The backend. With KE_CORE_URL (and KE_MANAGE_CREDENTIAL) it is a real core; otherwise the fake.
    Everything the tests ask of it goes through the contract, as a manage device would. */
export async function startBackend() {
  const real = process.env.KE_CORE_URL?.replace(/\/+$/, '');
  const fake = real ? null : createFakeCore();
  const url = real ?? (await fake.start(8794));
  const manage = real ? process.env.KE_MANAGE_CREDENTIAL : MANAGE_CREDENTIAL;
  if (!manage) throw new Error('KE_MANAGE_CREDENTIAL is needed with KE_CORE_URL: the credential of a manage device');
  const call = async (method, path, { credential = manage, body } = {}) => {
    const r = await fetch(url + path, { method, headers: { Authorization: `Bearer ${credential}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, data: type.includes('json') ? await r.json().catch(() => null) : Buffer.from(await r.arrayBuffer()) };
  };
  return {
    url,
    fake,
    name: real ? `real core at ${url}` : `fake core at ${url}`,
    call,
    request: (code) => call('GET', `/v1/device-codes/${code}/request`),
    approve: (code) => call('POST', `/v1/device-codes/${code}/approve`, { body: {} }),
    deny: (code) => call('POST', `/v1/device-codes/${code}/deny`),
    /** every item saved and not yet in a digest, with its body and asset */
    items: async () => {
      const list = await call('GET', '/v1/items?state=today&limit=100');
      if (list.status !== 200) throw new Error(`GET /v1/items → ${list.status}`);
      return Promise.all(list.data.items.map(async (i) => (await call('GET', `/v1/items/${i.id}`)).data));
    },
    asset: (id) => call('GET', `/v1/assets/${id}`),
    stop: async () => fake?.stop(),
    restart: async () => fake?.start(8794),
    close: async () => fake?.stop(),
  };
}

/** A 24-bit PNG without any library. */
export function png(width, height) {
  const row = Buffer.alloc(1 + width * 3);
  const rows = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = (x * 255) / width;
      row[2 + x * 3] = (y * 255) / height;
      row[3 + x * 3] = 120;
    }
    rows.push(Buffer.from(row));
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

export const SECRET = 'password = hunter2-Zx9!kLm';
export const PARAGRAPH = '第一种最朴素：给每份活一个由内容算出来的标识。\n第二种是租约：领活的人拿到一个会过期的凭据。';

/** The site to save from. Made-up content (rule E5). */
export async function startSite() {
  const image = png(2000, 1000);
  const page = (n) => `<!doctype html><html><head><meta charset="utf-8"><title>把定时任务做成幂等的七种写法 ${n}</title></head>
<body style="font:16px/1.6 system-ui;max-width:640px;margin:40px auto">
<h1>把定时任务做成幂等的七种写法</h1>
<p id="para" style="white-space:pre-line">${PARAGRAPH}</p>
<p>详见 <a id="link" href="/outbox">这篇关于发件箱模式的文章</a>。</p>
<p><code id="secret">${SECRET}</code></p>
<img id="img" src="/big.png" width="400" height="200">
</body></html>`;
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/big.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(image);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(u.pathname.slice(1) + u.search));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  return {
    /** the test build may script this host */
    url: `http://127.0.0.1:${port}`,
    /** the same site under a host the test build may not script: stands for the web store */
    closedUrl: `http://localhost:${port}`,
    close: () => new Promise((ok) => (server.closeAllConnections(), server.close(ok))),
  };
}

export async function launch(extensionDir, profileDir) {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium', // the new headless mode: the old one cannot load extensions
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, worker, id: new URL(worker.url()).host };
}

export async function until(what, check, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
    await new Promise((ok) => setTimeout(ok, 100));
  }
}

export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

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

/** A GIF 1 x 1 pixel with `n` pictures in it (the usual smallest one, repeated). */
export function gif(n) {
  const header = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00];
  const frame = [0x21, 0xf9, 0x04, 0x01, 0x0a, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00];
  return Buffer.from([...header, ...Array.from({ length: n }, () => frame).flat(), 0x3b]);
}

const SIDE = 8;
const pngChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const plain = (rgb) => deflateSync(Buffer.concat(Array.from({ length: SIDE }, () => Buffer.from([0, ...Array.from({ length: SIDE }, () => [...rgb, 255]).flat()]))));
const frameControl = (sequence) => {
  const d = Buffer.alloc(26);
  d.writeUInt32BE(sequence, 0);
  d.writeUInt32BE(SIDE, 4);
  d.writeUInt32BE(SIDE, 8);
  d.writeUInt16BE(10, 20); // 10 / 100 s
  d.writeUInt16BE(100, 22);
  return pngChunk('fcTL', d);
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const apngHeader = () => {
  const h = Buffer.alloc(13);
  h.writeUInt32BE(SIDE, 0);
  h.writeUInt32BE(SIDE, 4);
  h.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  return pngChunk('IHDR', h);
};

/** An APNG of 8 x 8 pixels that the browser can read, whose `acTL` says `frames` pictures (with 1 it is a still picture
    that carries the chunk). `rgb` is the first picture's colour: another colour is other bytes, so another asset. */
export function apng(frames, rgb = [200, 30, 30]) {
  const parts = [apngHeader(), pngChunk('acTL', Buffer.concat([u32(frames), u32(0)])), frameControl(0), pngChunk('IDAT', plain(rgb))];
  let sequence = 1;
  for (let f = 1; f < frames; f++) parts.push(frameControl(sequence++), pngChunk('fdAT', Buffer.concat([u32(sequence++), plain([30, 30, 200])])));
  return Buffer.concat([PNG_SIGNATURE, ...parts, pngChunk('IEND', Buffer.alloc(0))]);
}

/** The same header and chunks, with a picture that cannot be decoded: says two frames, and the browser cannot draw it. */
export function brokenApng() {
  return Buffer.concat([PNG_SIGNATURE, apngHeader(), pngChunk('acTL', Buffer.concat([u32(2), u32(0)])), frameControl(0), pngChunk('IDAT', Buffer.from('not a picture, however it is deflated')), frameControl(1), pngChunk('fdAT', Buffer.concat([u32(2), Buffer.from('nor this')])), pngChunk('IEND', Buffer.alloc(0))]);
}

const le = (n, bytes) => {
  const b = Buffer.alloc(bytes);
  b.writeUIntLE(n, 0, bytes);
  return b;
};
const riffChunk = (type, data) => Buffer.concat([Buffer.from(type, 'latin1'), le(data.length, 4), data, Buffer.alloc(data.length & 1)]);
/** A WebP made of chunks: "RIFF", the size, "WEBP", then them. */
export function riff(...chunks) {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), le(body.length, 4), body]);
}
/** The VP8X header of an 8 x 8 WebP, with these flags (0x02 is the animation flag). */
export const vp8x = (flags) => riffChunk('VP8X', Buffer.concat([Buffer.from([flags, 0, 0, 0]), le(SIDE - 1, 3), le(SIDE - 1, 3)]));
const anmf = (picture) => riffChunk('ANMF', Buffer.concat([le(0, 3), le(0, 3), le(SIDE - 1, 3), le(SIDE - 1, 3), le(100, 3), Buffer.from([0]), picture]));
/** An animated WebP of `frames` pictures, each one the `picture` chunks (VP8 or VP8L, with ALPH) of a still 8 x 8 WebP. */
export const animatedWebp = (picture, frames) => riff(vp8x(0x02), riffChunk('ANIM', Buffer.alloc(6)), ...Array.from({ length: frames }, () => anmf(picture)));

/** The picture chunks (VP8 or VP8L, with ALPH) of a still 8 x 8 WebP that this browser's own encoder makes, in `colour`. */
export async function webpPicture(page, colour = '#c81e1e') {
  const base64 = await page.evaluate(
    async ([side, fill]) => {
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const g = canvas.getContext('2d');
      g.fillStyle = fill;
      g.fillRect(0, 0, side, side);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 1));
      return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
    },
    [SIDE, colour],
  );
  const still = Buffer.from(base64, 'base64');
  const keep = [];
  for (let i = 12; i + 8 <= still.length; ) {
    const size = still.readUInt32LE(i + 4);
    const end = i + 8 + size + (size & 1);
    if (['ALPH', 'VP8 ', 'VP8L'].includes(still.toString('latin1', i, i + 4))) keep.push(still.subarray(i, end));
    i = end;
  }
  if (!keep.length) throw new Error('the encoder made a WebP without a picture in it');
  return Buffer.concat(keep);
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
  /** files a test puts on the site: path → { type, bytes } */
  const files = new Map();
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const made = files.get(u.pathname);
    if (made) return res.writeHead(200, { 'Content-Type': made.type }).end(made.bytes);
    if (u.pathname === '/big.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(image);
    if (u.pathname === '/motion.gif') return res.writeHead(200, { 'Content-Type': 'image/gif' }).end(gif(3));
    if (u.pathname === '/still.gif') return res.writeHead(200, { 'Content-Type': 'image/gif' }).end(gif(1));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(u.pathname.slice(1) + u.search));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  return {
    put: (path, type, bytes) => void files.set(path, { type, bytes }),
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

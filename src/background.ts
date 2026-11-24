/* Save to KeepEssence: the toolbar button and its key save the page; the right-click menu saves
   the page, the selection, a link or an image. One press, no popup, and one sentence in the page
   with what the core answered (rules B1, B2).

   - The sentence is put into the page (page.ts). Where a page cannot take it (the browser's own
     pages, the web store) a badge on the button and a system notification say the same words.
   - "Saved" is said only after the core answered. A save that could not leave is queued in
     chrome.storage.local and the sentence says so; it goes out later, silently.
   - Text that looks like a password is asked about first (rule B4), with the patterns the core
     served at GET /v1/meta.
   - This is a save-only device: nothing the user saved is ever read back (rule B11).

   Runs as a service worker, so nothing here lives in memory across events. */
import { LIMITS, SAVE_MESSAGES } from './generated/contract.ts';
import * as api from './lib/api.ts';
import { fromBase64, prepareImage } from './lib/image.ts';
import { imageAsLink, isWeb, menuTarget, MENUS, pageRequest, type Entry, type MenuInfo } from './lib/items.ts';
import { langOf, sentence, toneOf, type Outcome, type Tone } from './lib/messages.ts';
import { enqueue, flush, type SendOutcome } from './lib/queue.ts';
import { secretLike } from './lib/secret.ts';
import { mayReach, read, remove, serverAddress, write } from './lib/store.ts';
import type { Meta, PendingSave, SaveRequest, SaveResult } from './lib/types.ts';
import { grabImage, readSelection, showToast, type ToastOptions } from './page.ts';

const t = (name: string, subs?: string | string[]) => chrome.i18n.getMessage(name, subs) || name;
/* the language of the catalogue the browser picked, so the core's sentences and this extension's own words always match */
const lang = () => langOf(chrome.i18n.getMessage('lang'));

const META_FRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 20000;
const RAW_IMAGE_MAX = 25 * 1024 * 1024;
const ASK_MS = 45000;

/* ---------------------------------------------------------------- the shared rules */

async function fetchMeta(server: string): Promise<Meta | null> {
  const r = await api.getMeta({ server, lang: lang() });
  if (!r.ok || !r.data?.shared_rules) return null;
  await write({ meta: { server, at: Date.now(), meta: r.data } });
  return r.data;
}

/** The rules the core last served; fetched now when there are none yet. */
async function meta(server: string): Promise<Meta | null> {
  const { meta: cached } = await read('meta');
  if (cached && cached.server === server) {
    if (Date.now() - cached.at > META_FRESH_MS) void fetchMeta(server);
    return cached.meta;
  }
  return fetchMeta(server);
}

const limit = (m: Meta | null, name: keyof typeof LIMITS): number => {
  const v = Number(m?.limits?.[name]);
  return Number.isFinite(v) && v > 0 ? v : LIMITS[name];
};

/* ---------------------------------------------------------------- telling the user */

const SHOW_MS: Record<Tone, number> = { saved: 3000, duplicate: 3000, queued: 6000, failed: 6000, ask: ASK_MS };
const BADGE: Record<Tone, string> = { saved: '✓', duplicate: '✓', queued: '…', failed: '!', ask: '?' };

async function toast(tabId: number | undefined, o: ToastOptions): Promise<boolean> {
  if (tabId == null) return false;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: showToast, args: [o] });
    return r?.result === true;
  } catch {
    return false; // a page extensions may not touch
  }
}

/** Where the page cannot show the sentence: a badge on the button and a system notification. */
async function elsewhere(tabId: number | undefined, tone: Tone, text: string): Promise<void> {
  const on = tabId != null ? { tabId } : {};
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#0B0B0B', ...on });
    await chrome.action.setBadgeTextColor({ color: '#FFFFFF', ...on });
    await chrome.action.setBadgeText({ text: BADGE[tone], ...on });
    setTimeout(() => void chrome.action.setBadgeText({ text: '', ...on }).catch(() => {}), 5000);
  } catch {
    /* the tab is gone */
  }
  try {
    await chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/128.png'), title: t('ext_short_name'), message: text });
  } catch {
    /* notifications are off: the badge is what is left */
  }
}

async function say(tabId: number | undefined, tone: Tone, text: string): Promise<void> {
  if (!(await toast(tabId, { tone, text, ms: SHOW_MS[tone] }))) await elsewhere(tabId, tone, text);
}

async function tell(tabId: number | undefined, o: Outcome, server?: string): Promise<void> {
  const { meta: cached } = await read('meta');
  const rules = cached && (!server || cached.server === server) ? cached.meta.shared_rules : undefined;
  await say(tabId, toneOf(o), sentence(o, lang(), rules, SAVE_MESSAGES));
}

const fail = (tabId: number | undefined, why: string, server?: string) => tell(tabId, { type: 'failed', reason: t(why) }, server);

/* ---------------------------------------------------------------- sending one save */

type Sent =
  | { kind: 'answered'; result: SaveResult }
  | { kind: 'network' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; status: number; reason: string };

function problem(r: { status: number; code: string; message: string }): Sent {
  if (r.status === 0) return { kind: 'network' };
  if (r.status === 401) return { kind: 'unauthorized' };
  return { kind: 'error', status: r.status, reason: r.message || t('why_status', String(r.status)) };
}

/** Uploads the image when there is one, then saves the item. Always with the save's own
    Idempotency-Key, so sending it twice is one item. */
async function send(conn: api.Conn, entry: PendingSave): Promise<Sent> {
  let request = entry.request;
  if (entry.image) {
    const img = entry.image;
    const ticket = await api.requestUpload(conn, img.sha256, img.bytes, img.content_type);
    if (!ticket.ok) return problem(ticket);
    if (ticket.data.status === 'upload') {
      if (!ticket.data.upload_url) return { kind: 'error', status: 200, reason: t('why_status', '200') };
      const put = await api.uploadBytes(conn, ticket.data.upload_url, new Blob([fromBase64(img.base64)], { type: img.content_type }), img.content_type);
      if (!put.ok) return problem(put);
      const done = await api.completeUpload(conn, ticket.data.asset_id);
      if (!done.ok) return problem(done);
    }
    /* `stored`: the same bytes are already there. `over_quota`: nothing is uploaded and the core's sentence says so. */
    request = { ...request, asset_id: ticket.data.asset_id };
  }
  const r = await api.saveItem(conn, request, entry.key);
  return r.ok ? { kind: 'answered', result: r.data } : problem(r);
}

/* ---------------------------------------------------------------- the queue */

let chain: Promise<unknown> = Promise.resolve();
/** One change to the stored queue at a time. */
function withQueue<T>(change: (queue: PendingSave[]) => Promise<{ queue: PendingSave[]; value: T }>): Promise<T> {
  const next = chain.then(async () => {
    const { queue = [] } = await read('queue');
    const out = await change(queue);
    if (out.queue !== queue) await write({ queue: out.queue });
    return out.value;
  });
  chain = next.catch(() => {});
  return next;
}

const keep = (entry: PendingSave) => withQueue(async (queue) => ({ ...enqueue(queue, entry), value: null })).then(async () => (await read('queue')).queue?.some((e) => e.key === entry.key) ?? false);

let retry: ReturnType<typeof setTimeout> | undefined;
function retryLater(): void {
  clearTimeout(retry);
  retry = setTimeout(() => void flushQueue(), RETRY_MS); // the storage calls in it keep the worker awake while something waits
}

/** Sends what is waiting, silently. Only a save the core refuses for good is spoken about. */
async function flushQueue(): Promise<void> {
  const server = await serverAddress();
  const { credential } = await read('credential');
  if (!credential) return;
  const conn: api.Conn = { server, lang: lang(), credential };
  const report = await withQueue(async (queue) => {
    if (!queue.length) return { queue, value: null };
    const r = await flush(queue, async (entry): Promise<SendOutcome> => {
      const s = await send(conn, entry);
      if (s.kind === 'answered') return { kind: 'done' };
      if (s.kind === 'network') return { kind: 'later' };
      if (s.kind === 'unauthorized') return { kind: 'unauthorized' };
      if (s.status === 429 || s.status >= 500) return { kind: 'later' };
      return { kind: 'rejected', reason: s.reason };
    });
    return { queue: r.remaining, value: r };
  });
  if (!report) return;
  for (const x of report.rejected) await tell(undefined, { type: 'failed', reason: x.reason }, server);
  if (report.stopped === 'unauthorized') await remove('credential', 'device');
  if (report.stopped === 'later') retryLater();
}

/* ---------------------------------------------------------------- saving */

async function notConnected(tabId: number | undefined, entry: PendingSave, server: string): Promise<void> {
  if (await keep(entry)) await say(tabId, 'queued', t('not_connected'));
  else await fail(tabId, 'why_queue_full', server);
  await chrome.runtime.openOptionsPage(); // the user just pressed: this is where connecting happens
}

/** From a finished request to the sentence. */
async function deliver(entry: PendingSave, tabId: number | undefined, server: string): Promise<void> {
  const { credential } = await read('credential');
  if (!credential) return notConnected(tabId, entry, server);
  const sent = await send({ server, lang: lang(), credential }, entry);
  switch (sent.kind) {
    case 'answered':
      await tell(tabId, { type: 'answered', result: sent.result }, server);
      void flushQueue();
      return;
    case 'network':
      if (await keep(entry)) {
        await tell(tabId, { type: 'queued' }, server);
        retryLater();
      } else await fail(tabId, 'why_queue_full', server);
      return;
    case 'unauthorized': // revoked on the devices page: this browser has to be allowed again
      await remove('credential', 'device');
      return notConnected(tabId, entry, server);
    case 'error':
      return tell(tabId, { type: 'failed', reason: sent.reason }, server);
  }
}

async function ready(tabId: number | undefined): Promise<string | null> {
  const server = await serverAddress();
  if (await mayReach(server)) return server;
  await fail(tabId, 'why_permission');
  await chrome.runtime.openOptionsPage();
  return null;
}

const newSave = (request: SaveRequest): PendingSave => ({ key: crypto.randomUUID(), request, at: Date.now() });

/** A request without an image. Text is checked against the shared rule first. */
async function saveRequest(request: SaveRequest, tabId: number | undefined, confirmed = false): Promise<void> {
  const server = await ready(tabId);
  if (!server) return;
  if (request.text && !confirmed) {
    const m = await meta(server);
    if (!m?.shared_rules?.secret_like) return fail(tabId, 'why_unreachable', server); // cannot check: neither upload nor drop silently
    if (secretLike(request.text, m.shared_rules.secret_like)) return ask(request, tabId, server);
  }
  return deliver(newSave(request), tabId, server);
}

/* ---------------------------------------------------------------- looks like a password: ask first */

interface Ask {
  request: SaveRequest;
  tabId: number | undefined;
  at: number;
}

async function ask(request: SaveRequest, tabId: number | undefined, server: string): Promise<void> {
  const id = crypto.randomUUID();
  const { asks = {} } = (await chrome.storage.session.get('asks')) as { asks?: Record<string, Ask> };
  const now = Date.now();
  for (const k of Object.keys(asks)) if ((asks[k]?.at ?? 0) < now - 2 * ASK_MS) delete asks[k];
  asks[id] = { request, tabId, at: now };
  await chrome.storage.session.set({ asks }); // in memory only: what may be a password is not written to disk while it waits
  const { meta: cached } = await read('meta');
  const text = sentence({ type: 'ask' }, lang(), cached?.meta.shared_rules, SAVE_MESSAGES);
  const shown = await toast(tabId, { tone: 'ask', text, ms: ASK_MS, askId: id, yes: t('ask_yes'), no: t('ask_no'), declined: t('not_saved') });
  if (shown) return;
  delete asks[id];
  await chrome.storage.session.set({ asks });
  await fail(tabId, 'why_cannot_ask', server); // this page cannot show the question: say it was not saved, and why
}

async function answered(id: string, yes: boolean): Promise<void> {
  const { asks = {} } = (await chrome.storage.session.get('asks')) as { asks?: Record<string, Ask> };
  const a = asks[id];
  delete asks[id];
  await chrome.storage.session.set({ asks });
  if (a && yes) await saveRequest(a.request, a.tabId, true);
}

/* ---------------------------------------------------------------- images */

async function imageBytes(srcUrl: string, tabId: number | undefined, frameId: number | undefined): Promise<Blob | 'too_large' | null> {
  const fromUrl = async (url: string): Promise<Blob | 'too_large' | null> => {
    try {
      const r = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(20000) });
      if (!r.ok) return null;
      const b = await r.blob();
      return b.size > RAW_IMAGE_MAX ? 'too_large' : b.size ? b : null;
    } catch {
      return null;
    }
  };
  if (srcUrl.startsWith('data:')) return fromUrl(srcUrl);
  if (tabId != null) {
    try {
      const target = frameId ? { tabId, frameIds: [frameId] } : { tabId };
      const [r] = await chrome.scripting.executeScript({ target, func: grabImage, args: [srcUrl, RAW_IMAGE_MAX] });
      const got = r?.result;
      if (got && 'tooLarge' in got) return 'too_large';
      if (got) return fromUrl(got.dataUrl);
    } catch {
      /* the page cannot be scripted */
    }
  }
  return fromUrl(srcUrl); // works where the image's host allows it
}

async function saveImage(srcUrl: string, request: SaveRequest, tabId: number | undefined, frameId: number | undefined): Promise<void> {
  const server = await ready(tabId);
  if (!server) return;
  const m = await meta(server);
  const raw = await imageBytes(srcUrl, tabId, frameId);
  if (raw === 'too_large') return fail(tabId, 'why_image_large', server);
  const prepared = raw ? await prepareImage(raw, limit(m, 'image_long_edge_px'), limit(m, 'asset_max_bytes')) : null;
  if (prepared?.ok) return deliver({ ...newSave(request), image: prepared.image }, tabId, server);
  if (prepared && prepared.why === 'too_large') return fail(tabId, 'why_image_large', server);
  /* the browser may not read these bytes (another site's image): its address is saved as a link instead */
  const link = imageAsLink(srcUrl, request.entry);
  if (!link) return fail(tabId, 'why_image', server);
  return deliver(newSave(link), tabId, server);
}

/* ---------------------------------------------------------------- what the user presses */

async function selectionIn(tabId: number | undefined, frameId?: number): Promise<string> {
  if (tabId == null) return '';
  try {
    const target = frameId ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };
    const results = await chrome.scripting.executeScript({ target, func: readSelection });
    return results.map((r) => r.result ?? '').find((s) => s.trim()) ?? '';
  } catch {
    return '';
  }
}

async function pressed(tab: chrome.tabs.Tab | undefined, entry: Entry): Promise<void> {
  if (!isWeb(tab?.url)) return fail(tab?.id, 'why_not_web');
  const request = pageRequest(tab, await selectionIn(tab.id), entry);
  if (request) await saveRequest(request, tab.id);
}

async function menu(info: MenuInfo & { frameId?: number }, tab: chrome.tabs.Tab | undefined): Promise<void> {
  const selection = info.menuItemId === 'save-selection' ? await selectionIn(tab?.id, info.frameId) : undefined;
  const target = menuTarget(info, tab ?? {}, selection);
  if (target.what === 'request') return saveRequest(target.request, tab?.id);
  if (target.what === 'image') return saveImage(target.srcUrl, target.request, tab?.id, info.frameId);
  if (target.why === 'not_web') return fail(tab?.id, 'why_not_web');
}

async function menus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  for (const m of MENUS) chrome.contextMenus.create({ id: m.id, title: t(m.title), contexts: m.contexts });
}

chrome.runtime.onInstalled.addListener((details) => {
  void menus();
  if (details.reason === 'install') void chrome.runtime.openOptionsPage(); // first use: connecting starts there
});
chrome.runtime.onStartup.addListener(() => void menus());
chrome.action.onClicked.addListener((tab) => void pressed(tab, 'toolbar'));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'save-page') void pressed(tab, 'shortcut');
});
chrome.contextMenus.onClicked.addListener((info, tab) => void menu(info, tab));

chrome.runtime.onMessage.addListener((m: { type?: string; id?: string; save?: boolean } | undefined) => {
  if (m?.type === 'ke-answer' && typeof m.id === 'string') void answered(m.id, m.save === true);
  else if (m?.type === 'ke-flush') void flushQueue(); // the options page: just connected
  return false;
});

/* what is waiting goes out when the browser is back online, and whenever the worker wakes */
self.addEventListener('online', () => void flushQueue());
void flushQueue();

/* Test builds only (dist-test/, never packaged; build.mjs drops this labelled block otherwise): an automated browser cannot press the toolbar
   button, the key or the right-click menu, so the same three entry points are reachable by tab id. */
TEST: {
  /* without activeTab the browser hides a tab's address on hosts the build may not touch: the test passes it in */
  const tabOf = async (tabId: number, as?: Partial<chrome.tabs.Tab>) => ({ ...(await chrome.tabs.get(tabId)), ...as });
  (globalThis as unknown as { keTest: unknown }).keTest = {
    toolbar: async (tabId: number, as?: Partial<chrome.tabs.Tab>) => pressed(await tabOf(tabId, as), 'toolbar'),
    shortcut: async (tabId: number, as?: Partial<chrome.tabs.Tab>) => pressed(await tabOf(tabId, as), 'shortcut'),
    menu: async (info: MenuInfo & { frameId?: number }, tabId: number, as?: Partial<chrome.tabs.Tab>) => menu(info, await tabOf(tabId, as)),
  };
}

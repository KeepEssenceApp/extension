/* End to end, in a real Chromium with the unpacked extension loaded: acceptance E1–E4
   (spec/product/acceptance.md §5).

   The browser's own toolbar button, key and right-click menu cannot be pressed by an automated
   browser, so the test build exposes the three handlers behind them (see the end of
   src/background.ts); everything after the press is the real code in a real page. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { webpSize } from '../../dev/fake-core.mjs';
import { contract, launch, PARAGRAPH, root, SECRET, sleep, startBackend, startSite, until } from './helpers.mjs';

const T = { timeout: 90000 };
let backend, site, context, id, options, lang, profile;
const say = (key) => contract['x-shared-rules'].save_messages[key][lang];

/** the service worker, woken if the browser put it to sleep */
async function sw() {
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'ke-ping' }).catch(() => {}));
  return until('the service worker', () => context.serviceWorkers().find((w) => w.url().includes(id)));
}
const inWorker = async (fn, arg) => (await sw()).evaluate(fn, arg);
const stored = (key) => inWorker(async (k) => (await chrome.storage.local.get(k))[k], key);
const word = (key, sub) => inWorker(([k, s]) => chrome.i18n.getMessage(k, s), [key, sub]);

async function tabIdOf(page) {
  await page.bringToFront();
  return until('the active tab', () => inWorker(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id));
}
async function open(url) {
  const page = await context.newPage();
  await page.goto(url);
  return page;
}
const press = async (page, how = 'toolbar', as) => {
  const tabId = await tabIdOf(page);
  await inWorker(([h, t, a]) => void globalThis.keTest[h](t, a), [how, tabId, as]);
};
const menu = async (page, info, as) => {
  const tabId = await tabIdOf(page);
  await inWorker(([i, t, a]) => void globalThis.keTest.menu(i, t, a), [info, tabId, as]);
};
const toastText = (page) => page.locator('#keepessence-toast .text');
const expectToast = async (page, text) => {
  await toastText(page).waitFor({ timeout: 20000 });
  assert.equal(await toastText(page).textContent(), text);
};
const select = (page, selector) =>
  page.evaluate((s) => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(s));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return String(sel);
  }, selector);
const code = async () => (await options.locator('#code').textContent()).trim();
const view = () => options.locator('#connection').getAttribute('data-view');
const itemsWith = async (pred) => (await backend.items()).filter(pred);

before(async () => {
  backend = await startBackend();
  site = await startSite();
  profile = mkdtempSync(join(tmpdir(), 'ke-ext-'));
  ({ context, id } = await launch(join(root, 'dist-test'), profile));
  /* first use: installing opens the options page by itself */
  options = await until('the options page', () => context.pages().find((p) => p.url().startsWith(`chrome-extension://${id}/options.html`)));
  await options.waitForLoadState();
  lang = (await inWorker(() => chrome.i18n.getUILanguage())).toLowerCase().startsWith('zh') ? 'zh' : 'en';
  console.log(`# backend: ${backend.name}; browser ${context.browser()?.version() ?? ''}; language ${lang}`);
}, T);

after(async () => {
  await context?.close();
  await site?.close();
  await backend?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

test('E1 connecting: a short code is shown large, asked for the save tier, and approved on a manage device', T, async () => {
  await until('a short code', async () => /^[A-Z0-9]{3,4}-[A-Z0-9]{3,4}$/.test(await code()));
  assert.equal(await view(), 'connect');
  const size = await options.locator('#code').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(size >= 32, `the code is large (${size}px)`);
  assert.match(await options.locator('#name').inputValue(), /^(Chrome|Chromium|Edge|Brave) on \w+$/);
  assert.equal(await options.locator('#code-say').textContent(), await word('opt_code_say'));

  /* the name can be edited; that asks for a new code */
  const first = await code();
  await options.locator('#name').fill('E2E Chromium');
  await options.locator('#name').blur();
  const second = await until('a new code for the new name', async () => ((await code()) !== first && (await code())) || null);

  /* what the manage device sees: who asks, and for which tier */
  const asked = await backend.request(second);
  assert.equal(asked.status, 200);
  assert.deepEqual([asked.data.device_name, asked.data.client, asked.data.requested_tier], ['E2E Chromium', 'extension', 'save']);

  /* the button opens approve_url, in a tab, because the user pressed it */
  const [approvePage] = await Promise.all([context.waitForEvent('page'), options.locator('#approve').click()]);
  await approvePage.waitForLoadState();
  assert.ok(approvePage.url().startsWith(backend.url), approvePage.url());
  await approvePage.close();

  assert.equal((await backend.approve(second)).status, 200);
  await until('the connected view', async () => (await view()) === 'connected');
  assert.equal(await options.locator('#connected-line').textContent(), await word('opt_connected', 'E2E Chromium'));
  assert.equal(await options.locator('#server-line').textContent(), await word('opt_server_at', backend.url));
  assert.ok(await options.locator('#disconnect').isVisible());

  /* the credential is stored and never shown */
  const credential = await stored('credential');
  assert.ok(typeof credential === 'string' && credential.length >= 16);
  assert.ok(!(await options.content()).includes(credential), 'the credential is nowhere in the page');
  const me = await backend.call('GET', '/v1/devices/me', { credential });
  assert.equal(me.status, 200);
  assert.deepEqual([me.data.device.name, me.data.device.tier], ['E2E Chromium', 'save']);
});

test('E2 E3 toolbar button: one press saves the page and says one sentence, with no window to dismiss', T, async () => {
  const page = await open(`${site.url}/toolbar`);
  const pagesBefore = context.pages().length;
  await press(page);
  await expectToast(page, say('saved'));
  assert.equal(context.pages().length, pagesBefore, 'nothing was opened');
  const box = await page.locator('#keepessence-toast .toast').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box.x + box.width > viewport.width - 40 && box.y + box.height > viewport.height - 40, 'bottom right');
  const [item] = await itemsWith((i) => i.url === `${site.url}/toolbar`);
  assert.equal(item.kind, 'link');
  assert.equal(item.title, '把定时任务做成幂等的七种写法 toolbar');
  await until('the sentence to leave by itself', async () => (await page.locator('#keepessence-toast').count()) === 0, 8000);

  if (backend.fake) {
    const sent = backend.fake.state.requests.filter((r) => r.method === 'POST' && r.path === '/v1/items').at(-1);
    assert.deepEqual(sent.body, { kind: 'link', url: `${site.url}/toolbar`, title: '把定时任务做成幂等的七种写法 toolbar', entry: 'toolbar' }); // no tags, no triage (B7)
    assert.match(sent.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
    assert.equal(sent.headers['accept-language'], lang);
    assert.equal(sent.headers.cookie, undefined);
  }
  await page.close();
});

test('E3 a duplicate says so and adds nothing', T, async () => {
  const page = await open(`${site.url}/toolbar`);
  await press(page);
  await expectToast(page, say('duplicate'));
  assert.equal((await itemsWith((i) => i.url === `${site.url}/toolbar`)).length, 1);
  await page.close();
});

test('E2 keyboard command: saves the page, with the selected text when there is one', T, async () => {
  const command = (await inWorker(() => chrome.commands.getAll())).find((c) => c.name === 'save-page');
  assert.ok(command, 'the command exists');
  console.log(`# save-page shortcut as the browser assigned it: ${JSON.stringify(command.shortcut)}`);
  const page = await open(`${site.url}/shortcut`);
  const selection = await select(page, '#para');
  await press(page, 'shortcut');
  await expectToast(page, say('saved'));
  const [item] = await itemsWith((i) => i.url === `${site.url}/shortcut`);
  assert.equal(item.kind, 'link');
  assert.equal(item.body, selection.trim());
  assert.ok(item.body.includes('\n'), 'line breaks are kept');
  await page.close();
});

test('E2 context menu: the page, the selection, a link, an image', T, async () => {
  const page = await open(`${site.url}/menu`);
  const pageUrl = `${site.url}/menu`;

  await menu(page, { menuItemId: 'save-page', pageUrl });
  await expectToast(page, say('saved'));
  assert.equal((await itemsWith((i) => i.kind === 'link' && i.url === pageUrl)).length, 1);

  await select(page, '#para');
  await menu(page, { menuItemId: 'save-selection', pageUrl, selectionText: PARAGRAPH.replace('\n', ' ') });
  await until('the selection to be saved', async () => (await itemsWith((i) => i.kind === 'text')).length === 1);
  await expectToast(page, say('saved'));
  const [text] = await itemsWith((i) => i.kind === 'text');
  assert.equal(text.body, PARAGRAPH);
  assert.equal(text.url, pageUrl);

  await menu(page, { menuItemId: 'save-link', pageUrl, linkUrl: `${site.url}/outbox` });
  await until('the link to be saved', async () => (await itemsWith((i) => i.url === `${site.url}/outbox`)).length === 1);
  await expectToast(page, say('saved'));

  /* an image: fetched, converted to WebP with the long edge at 1600, hashed, uploaded, saved with the page as origin */
  await menu(page, { menuItemId: 'save-image', pageUrl, srcUrl: `${site.url}/big.png` });
  const image = await until('the image to be saved', async () => (await itemsWith((i) => i.kind === 'image'))[0], 30000);
  await expectToast(page, say('saved'));
  assert.equal(image.url, pageUrl);
  const asset = await backend.asset(image.asset_id);
  assert.equal(asset.status, 200);
  assert.deepEqual(webpSize(asset.data), { width: 1600, height: 800 });
  assert.ok(asset.data.length <= contract['x-limits'].asset_max_bytes);
  if (backend.fake) {
    const a = backend.fake.state.assets.get(image.asset_id);
    assert.equal(a.sha256, createHash('sha256').update(asset.data).digest('hex'));
    assert.equal(a.content_type, 'image/webp');
    const put = backend.fake.state.requests.find((r) => r.method === 'PUT');
    assert.equal(put.headers.authorization, undefined, 'the credential is not sent to the upload address');
  }

  /* the same image again: the same bytes are not uploaded twice */
  const uploads = backend.fake?.state.requests.filter((r) => r.method === 'PUT').length;
  await menu(page, { menuItemId: 'save-image', pageUrl, srcUrl: `${site.url}/big.png` });
  await until('the second image item', async () => (await itemsWith((i) => i.kind === 'image')).length === 2, 30000);
  if (backend.fake) assert.equal(backend.fake.state.requests.filter((r) => r.method === 'PUT').length, uploads);
  await page.close();
});

test('E4 text that looks like a password is asked about first: never uploaded silently, never dropped silently', T, async () => {
  const page = await open(`${site.url}/secret`);
  const pageUrl = `${site.url}/secret`;
  const count = async () => (await backend.items()).length;
  const before = await count();

  await select(page, '#secret');
  await menu(page, { menuItemId: 'save-selection', pageUrl, selectionText: SECRET });
  await expectToast(page, say('secret_like_question'));
  const buttons = page.locator('#keepessence-toast button');
  assert.equal(await buttons.count(), 2);
  assert.deepEqual(await buttons.allTextContents(), [await word('ask_no'), await word('ask_yes')]);
  await sleep(1500);
  assert.equal(await count(), before, 'nothing was sent while the question is open');

  await page.locator('#keepessence-toast button[data-answer="no"]').click();
  await expectToast(page, await word('not_saved'));
  await sleep(1000);
  assert.equal(await count(), before, '"no" saves nothing, and says so');

  /* the toolbar button with a selected password asks too; "yes" saves it */
  await press(page);
  await expectToast(page, say('secret_like_question'));
  assert.equal(await count(), before);
  await page.locator('#keepessence-toast button[data-answer="yes"]').click();
  await until('the confirmed save', async () => (await count()) === before + 1);
  await expectToast(page, say('saved'));
  const [item] = await itemsWith((i) => i.url === pageUrl);
  assert.equal(item.body, SECRET);
  await page.close();
});

test('E3 offline: the sentence says queued, not saved; it is sent when the browser is back, silently', T, async (t) => {
  if (!backend.fake) return t.skip('a real core cannot be switched off from here; covered against the fake core');
  const page = await open(`${site.url}/offline`);
  const pageUrl = `${site.url}/offline`;
  await backend.stop();
  await press(page);
  await expectToast(page, say('queued_offline'));
  const queue = await stored('queue');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].request.url, pageUrl);
  await until('the options page to say one is queued', async () => (await options.locator('#queued-line').textContent()) === (await word('opt_queued', '1')));
  await until('the queued sentence to leave', async () => (await page.locator('#keepessence-toast').count()) === 0, 10000);

  await backend.restart();
  assert.equal((await itemsWith((i) => i.url === pageUrl)).length, 0);
  await inWorker(() => void self.dispatchEvent(new Event('online')));
  await until('the queued save to arrive', async () => (await itemsWith((i) => i.url === pageUrl)).length === 1);
  await until('the queue to empty', async () => ((await stored('queue')) ?? []).length === 0);
  const sent = backend.fake.state.requests.filter((r) => r.method === 'POST' && r.path === '/v1/items' && r.body?.url === pageUrl);
  assert.equal(sent.at(-1).headers['idempotency-key'], queue[0].key, 'the same Idempotency-Key as when it was pressed');
  await sleep(800);
  assert.equal(await page.locator('#keepessence-toast').count(), 0, 'sent silently');
  await page.close();
});

test('E3 where a page cannot be scripted: a badge on the button and a system notification', T, async () => {
  /* a host the build may not touch, as the web store is for a packaged build */
  const page = await open(`${site.closedUrl}/closed`);
  const pageUrl = `${site.closedUrl}/closed`;
  const tabId = await tabIdOf(page);
  await inWorker(() => new Promise((ok) => chrome.notifications.getAll((all) => Promise.all(Object.keys(all).map((n) => chrome.notifications.clear(n))).then(ok))));
  await press(page, 'toolbar', { url: pageUrl, title: 'Closed page' });
  await until('the item', async () => (await itemsWith((i) => i.url === pageUrl)).length === 1);
  await until('the badge', async () => (await inWorker((t) => chrome.action.getBadgeText({ tabId: t }), tabId)) === '✓');
  assert.equal(await page.locator('#keepessence-toast').count(), 0);
  const notes = await until('the notification', async () => {
    const all = await inWorker(() => new Promise((ok) => chrome.notifications.getAll(ok)));
    return Object.keys(all).length ? all : null;
  });
  assert.equal(Object.keys(notes).length, 1);
  await page.close();

  /* the browser's own page: not saved, and it says why */
  const own = await context.newPage();
  await own.goto('chrome://version/');
  const ownTab = await tabIdOf(own);
  const before = (await backend.items()).length;
  await press(own, 'toolbar', { url: 'chrome://version/' });
  await until('the badge', async () => (await inWorker((t) => chrome.action.getBadgeText({ tabId: t }), ownTab)) === '!');
  assert.equal((await backend.items()).length, before);
  await own.close();
});

test('E4 no reading interface: a save-only device, no popup, and no code that reads', T, async () => {
  /* the device this browser is cannot read anything */
  const credential = await stored('credential');
  for (const path of ['/v1/items?state=today', '/v1/notes', '/v1/digests']) {
    const r = await backend.call('GET', path, { credential });
    assert.ok([403, 404].includes(r.status), `${path} → ${r.status}`);
    assert.equal(r.status === 200, false);
  }
  /* the packaged build: no popup, no page besides the options page, only the stated permissions */
  const manifest = JSON.parse(readFileSync(join(root, 'dist/manifest.json'), 'utf8'));
  assert.equal(manifest.action.default_popup, undefined);
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'contextMenus', 'notifications', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://keepessence.app/*']);
  assert.equal(manifest.content_scripts, undefined);
  /* the only paths in the code are the ones a saving client may use */
  const allowed = ['/v1/meta', '/v1/device-codes', '/v1/device-codes/', '/v1/devices/me', '/v1/items', '/v1/assets', '/v1/assets/'];
  for (const file of ['background.js', 'options.js']) {
    const js = readFileSync(join(root, 'dist', file), 'utf8');
    const paths = [...js.matchAll(/["'`](\/v1\/[a-z\/-]+)/g)].map((m) => m[1]);
    assert.ok(paths.length > 0);
    assert.deepEqual(paths.filter((p) => !allowed.includes(p)), [], file);
    assert.ok(!js.includes('keTest'), 'the test hooks are not in the packaged build');
  }
  /* the options page shows nothing that was saved */
  const text = await options.locator('body').innerText();
  for (const item of await backend.items()) {
    if (item.title) assert.ok(!text.includes(item.title));
    if (item.body) assert.ok(!text.includes(item.body));
  }
});

test('E1 refused: it says so, and another code can be asked for', T, async () => {
  /* revoked from the devices page of a manage device, here by the device itself */
  const credential = await stored('credential');
  await options.locator('#disconnect').click();
  await until('the connect view', async () => (await view()) === 'connect' && /^[A-Z0-9]{3,4}-[A-Z0-9]{3,4}$/.test(await code()));
  assert.equal(await stored('credential'), undefined);
  assert.equal((await backend.call('GET', '/v1/devices/me', { credential })).status, 401, 'disconnect revoked the device');

  const refused = await code();
  assert.ok([204, 200].includes((await backend.deny(refused)).status));
  await until('the refusal', async () => (await options.locator('#code-state').textContent()) === (await word('opt_code_denied')));
  assert.equal(await stored('credential'), undefined);
  await options.locator('#again').click();
  await until('another code', async () => ((await code()) !== refused && /^[A-Z0-9]{3,4}-[A-Z0-9]{3,4}$/.test(await code())) || null);
});

test('E3 not connected: the save waits, the sentence says so, and it is saved once the browser is allowed', T, async () => {
  const page = await open(`${site.url}/unconnected`);
  const pageUrl = `${site.url}/unconnected`;
  await press(page);
  await expectToast(page, await word('not_connected'));
  assert.equal((await stored('queue')).length, 1);
  assert.equal((await itemsWith((i) => i.url === pageUrl)).length, 0);

  await options.bringToFront();
  assert.equal((await backend.approve(await code())).status, 200);
  await until('the connected view', async () => (await view()) === 'connected');
  await until('the waiting save to arrive', async () => (await itemsWith((i) => i.url === pageUrl)).length === 1);
  await until('the queue to empty', async () => ((await stored('queue')) ?? []).length === 0);
  await page.close();
});

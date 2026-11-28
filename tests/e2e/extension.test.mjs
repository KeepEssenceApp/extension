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
import { animatedWebp, apng, brokenApng, contract, launch, PARAGRAPH, riff, root, SECRET, sleep, startBackend, startSite, until, vp8x, webpPicture } from './helpers.mjs';

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
  /* the sentence before it may still be leaving: wait for this one, then compare exactly */
  await until(`the sentence ${JSON.stringify(text)}`, async () => (await toastText(page).textContent({ timeout: 500 })) === text, 20000).catch(() => {});
  assert.equal(await toastText(page).textContent({ timeout: 2000 }), text);
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
  lang = await inWorker(() => chrome.i18n.getMessage('lang'));
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
  /* what happens to a picture is said here, once, and not in a window or with each save (QA #87) */
  assert.equal(await options.locator('#images').textContent(), await word('opt_images'));

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

/* W8 (spec e139a47, internal-qa #107): one scale of rounding. The real options page, with "advanced" opened, and what the
   browser computes for the three controls QA measured: sharing only the colour table left all three at 14px (card, field,
   button), because the components still named --ke-radius. Everything is read from the browser, not from the CSS text. */
const corners = (locator) =>
  locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius];
  });
const all = (px) => [px, px, px, px];

test('W8 the options page: the card is 20px, the address field 14px, the save button a pill (999px)', T, async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await page.waitForLoadState();
  assert.equal(await page.locator('#advanced').evaluate((el) => el.open), false, 'advanced starts closed');
  await page.locator('#advanced > summary').click();
  assert.equal(await page.locator('#advanced').evaluate((el) => el.open), true, 'advanced is open');
  await page.locator('#server').waitFor({ state: 'visible' });
  await page.locator('#server-save').waitFor({ state: 'visible' });

  assert.deepEqual(await corners(page.locator('#advanced')), all('20px'), 'the card: --ke-radius-card');
  assert.deepEqual(await corners(page.locator('#server')), all('14px'), 'the address field: --ke-radius');
  assert.deepEqual(await corners(page.locator('#server-save')), all('999px'), 'the save button: --ke-radius-control');

  /* the same scale everywhere on the page, so a control added later cannot slip back to 6px: every rounded corner is on the scale */
  const off = await page.evaluate(() => {
    const scale = new Set(['0px', '8px', '14px', '20px', '28px', '999px']);
    const bad = [];
    for (const el of document.querySelectorAll('body, body *')) {
      const s = getComputedStyle(el);
      for (const c of [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius]) {
        if (!scale.has(c)) bad.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} ${c}`);
      }
    }
    return bad;
  });
  assert.deepEqual(off, [], 'no corner off the scale 0, 8, 14, 20, 28, 999');
  /* the other cards and buttons of the page too (they are in views that are not shown now, but they are in the page) */
  const every = (selector) => page.locator(selector).evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).borderTopLeftRadius))]);
  assert.deepEqual(await every('.card'), ['20px']);
  assert.deepEqual(await every('button'), ['999px']);
  assert.deepEqual(await every('input'), ['14px']);
  await page.close();
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
  /* the four entries exist in the browser's menu (updating one that does not exist is an error) */
  for (const entry of ['save-page', 'save-selection', 'save-link', 'save-image']) await inWorker((e) => chrome.contextMenus.update(e, {}), entry);

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

  /* another site's image, which the browser may not read: its address is saved as a link, and the sentence is still the core's */
  const foreign = `${site.closedUrl}/big.png`;
  await menu(page, { menuItemId: 'save-image', pageUrl, srcUrl: foreign });
  const asLink = await until('the image saved by its address', async () => (await itemsWith((i) => i.url === foreign))[0], 30000);
  assert.equal(asLink.kind, 'link');
  /* what was saved is not what was pressed, and the sentence says so (QA #87): not the plain "saved" */
  await expectToast(page, await word('saved_image_as_link'));
  assert.notEqual(await word('saved_image_as_link'), say('saved'));
  /* the same foreign image again: the address was saved already, and that is what the sentence says (the core's, the true one) */
  await menu(page, { menuItemId: 'save-image', pageUrl, srcUrl: foreign });
  await expectToast(page, say('duplicate'));

  /* an animated GIF is kept as one picture, and the sentence says so after the core's own; a still GIF says nothing more (QA #87) */
  await menu(page, { menuItemId: 'save-image', pageUrl, srcUrl: `${site.url}/motion.gif` });
  await expectToast(page, `${say('saved')} ${await word('gif_one_frame')}`);
  await menu(page, { menuItemId: 'save-image', pageUrl, srcUrl: `${site.url}/still.gif` });
  await expectToast(page, say('saved'));

  /* the same image again: the same bytes are not uploaded twice */
  const uploads = backend.fake?.state.requests.filter((r) => r.method === 'PUT').length;
  await menu(page, { menuItemId: 'save-image', pageUrl, srcUrl: `${site.url}/big.png` });
  await until('the second image item', async () => (await itemsWith((i) => i.kind === 'image')).length === 4, 30000);
  if (backend.fake) assert.equal(backend.fake.state.requests.filter((r) => r.method === 'PUT').length, uploads);
  await page.close();
});

/* QA #87 (ruling 2026-11-28): the count is the file's own, so an APNG and an animated WebP are told like a GIF. Each save is
   read on a page of its own, so that no sentence of an earlier save is still on it. */
const savedSentence = async (srcUrl) => {
  const here = `${site.url}/frames`;
  const page = await open(here);
  await menu(page, { menuItemId: 'save-image', pageUrl: here, srcUrl });
  await until(`a sentence for ${srcUrl}`, async () => (await toastText(page).count()) > 0, 30000);
  const text = await toastText(page).textContent();
  await page.close();
  return text;
};
const pictures = async () => {
  const seed = await open(`${site.url}/frames`);
  const pics = { red: await webpPicture(seed), blue: await webpPicture(seed, '#1e90c8') };
  await seed.close();
  return pics;
};

test('E2 E3 an APNG and an animated WebP kept as one picture say so after the core\'s sentence, as a GIF does; a still one does not (QA #87)', T, async () => {
  const one = await word('gif_one_frame');
  const { red } = await pictures();
  const cases = [
    ['an APNG of two frames', '/two.png', 'image/png', apng(2), true],
    ['an APNG of five frames', '/five.png', 'image/png', apng(5), true],
    ['an animated WebP of two frames', '/two.webp', 'image/webp', animatedWebp(red, 2), true],
    ['an animated WebP served under the wrong type', '/wrong-type.png', 'image/png', animatedWebp(red, 2), true],
    ['a PNG that has an acTL chunk with one frame', '/one.png', 'image/png', apng(1), false],
    ['a still WebP', '/still.webp', 'image/webp', riff(red), false],
    ['a still WebP under a VP8X header without the animation flag', '/vp8x.webp', 'image/webp', riff(vp8x(0x10), red), false],
    ['a WebP with the animation flag and one frame', '/flag-one.webp', 'image/webp', animatedWebp(red, 1), false],
  ];
  for (const [name, path, type, bytes, says] of cases) {
    site.put(path, type, bytes);
    assert.equal(await savedSentence(`${site.url}${path}`), says ? `${say('saved')} ${one}` : say('saved'), name);
  }
  assert.ok(!one.includes('第一') && !/first/i.test(one), 'it says "one frame", not which');
});

test('E3 an animation whose picture was not stored does not say that a frame was kept: not over the storage quota, not when the picture cannot be read (QA #87)', T, async (t) => {
  const { blue } = await pictures();
  const one = await word('gif_one_frame');
  /* the picture cannot be drawn: its address is saved instead, and the sentence says that, not that a frame was kept */
  site.put('/broken.png', 'image/png', brokenApng());
  const unreadable = await savedSentence(`${site.url}/broken.png`);
  assert.equal(unreadable, await word('saved_image_as_link'));
  assert.ok(!unreadable.includes(one));
  if (!backend.fake) return t.skip('a real core cannot be filled from here; the quota is covered against the fake core');
  /* the core records the item and says the picture was not stored (new colours: the same bytes would be an asset it has already) */
  site.put('/quota.png', 'image/png', apng(2, [11, 99, 177]));
  site.put('/quota.webp', 'image/webp', animatedWebp(blue, 2));
  backend.fake.state.quotaFull = true;
  try {
    for (const path of ['/quota.png', '/quota.webp']) assert.equal(await savedSentence(`${site.url}${path}`), say('saved_image_skipped_quota'), path);
  } finally {
    backend.fake.state.quotaFull = false;
  }
});

test('E3 offline: an animation is queued and the sentence says queued, not that a frame was kept; the queue sends it later (QA #87)', T, async (t) => {
  if (!backend.fake) return t.skip('a real core cannot be switched off from here; covered against the fake core');
  const { blue } = await pictures();
  site.put('/queued.png', 'image/png', apng(2, [77, 11, 150]));
  site.put('/queued.webp', 'image/webp', animatedWebp(blue, 2));
  const before = (await itemsWith((i) => i.kind === 'image')).length;
  await backend.stop();
  try {
    for (const path of ['/queued.png', '/queued.webp']) assert.equal(await savedSentence(`${site.url}${path}`), say('queued_offline'), path);
  } finally {
    await backend.restart();
  }
  assert.equal(((await stored('queue')) ?? []).filter((q) => q.request.kind === 'image').length, 2, 'both wait in the queue');
  await inWorker(() => void self.dispatchEvent(new Event('online')));
  await until('the queue to empty', async () => ((await stored('queue')) ?? []).length === 0, 30000);
  await until('the queued images to arrive', async () => (await itemsWith((i) => i.kind === 'image')).length === before + 2, 30000);
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
  /* W8: the notice in the page is a small block (14px) and its two buttons are pills (999px); literals in a shadow root (#107) */
  assert.deepEqual(await corners(page.locator('#keepessence-toast .toast')), all('14px'), 'the notice: --ke-radius');
  assert.deepEqual(await buttons.evaluateAll((els) => els.map((el) => getComputedStyle(el).borderTopLeftRadius)), ['999px', '999px'], 'its buttons: --ke-radius-control');
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

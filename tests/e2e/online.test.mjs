/* Acceptance X4, online: the packaged build (dist/) against a deployed core, nothing faked.
   Runs only when asked for:

     KE_ONLINE=1 KE_MANAGE_CREDENTIAL=<credential of a manage device> node --test tests/e2e/online.test.mjs

   It connects with a short code (approved through the core as that manage device), presses the
   real toolbar button on a public page, checks the sentence and that the item is in the user's
   today list, presses again for the duplicate sentence, then disconnects (the device is revoked).
   It leaves one saved link behind. Use a test account and made-up content. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { contract, root, until } from './helpers.mjs';

const ONLINE = process.env.KE_ONLINE === '1';
const CORE = (process.env.KE_ONLINE_URL ?? 'https://keepessence.app').replace(/\/+$/, '');
const MANAGE = process.env.KE_MANAGE_CREDENTIAL ?? '';
const T = { timeout: 120000, skip: ONLINE ? false : 'set KE_ONLINE=1 to run against the deployed core' };

let context, id, options, session, tmp, lang;
const say = (key) => contract['x-shared-rules'].save_messages[key][lang];
const worker = () => until('the service worker', () => context.serviceWorkers().find((w) => w.url().includes(id)));
const core = (method, path, body) =>
  fetch(CORE + path, { method, headers: { Authorization: `Bearer ${MANAGE}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined });
const toast = (page) => page.locator('#keepessence-toast .text');

async function clickToolbarButton(page) {
  await page.bringToFront();
  const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = targetInfos.find((t) => t.url === page.url());
  assert.ok(tab, 'the tab of this page');
  await session.send('Extensions.triggerAction', { id, targetId: tab.targetId });
}

before(async () => {
  if (!ONLINE) return;
  assert.ok(MANAGE, 'KE_MANAGE_CREDENTIAL is needed');
  tmp = mkdtempSync(join(tmpdir(), 'ke-online-'));
  const dir = join(root, 'dist');
  context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  const w = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  id = new URL(w.url()).host;
  session = await context.browser().newBrowserCDPSession();
  options = await until('the options page', () => context.pages().find((p) => p.url().startsWith(`chrome-extension://${id}/options.html`)));
  await options.waitForLoadState();
  lang = await (await worker()).evaluate(() => chrome.i18n.getMessage('lang'));
}, { timeout: 120000 });

after(async () => {
  await context?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('online: short code, a real press saves a public page, duplicate, disconnect', T, async () => {
  const code = await until('a short code', async () => {
    const c = (await options.locator('#code').textContent()).trim();
    return /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(c) ? c : null;
  }, 30000);
  const asking = await (await core('GET', `/v1/device-codes/${code}/request`)).json();
  assert.equal(asking.client, 'extension');
  assert.equal(asking.requested_tier, 'save');
  assert.equal((await core('POST', `/v1/device-codes/${code}/approve`)).status, 200);
  await until('the connected view', async () => (await options.locator('#connection').getAttribute('data-view')) === 'connected', 30000);
  assert.ok(!(await options.content()).includes(MANAGE.slice(0, 12)), 'no credential on the page');

  const url = `https://example.com/?ke-online=${Date.now()}`;
  const page = await context.newPage();
  await page.goto(url);
  const pages = context.pages().length;
  await clickToolbarButton(page);
  await until('the saved sentence', async () => (await toast(page).textContent({ timeout: 500 })) === say('saved'), 30000);
  assert.equal(context.pages().length, pages, 'no window, no popup');

  const today = await (await core('GET', '/v1/items?state=today&limit=100')).json();
  assert.ok(today.items.some((i) => i.url === url), 'the page is in the today list');

  await clickToolbarButton(page);
  await until('the duplicate sentence', async () => (await toast(page).textContent({ timeout: 500 })) === say('duplicate'), 30000);
  await page.close();

  // The extension can read nothing with its own credential (save tier only).
  const own = await (await worker()).evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const credential = Object.values(all).map((v) => (v && typeof v === 'object' ? v.credential : null)).find(Boolean) ?? all.credential;
    const r = await fetch('https://keepessence.app/v1/items?state=today', { headers: { Authorization: `Bearer ${credential}` } });
    return r.status;
  });
  assert.equal(own, 403);

  await options.bringToFront();
  await options.locator('#disconnect').click();
  await until('the code view again', async () => (await options.locator('#connection').getAttribute('data-view')) !== 'connected', 30000);
});

/* The packaged build (dist/, exactly what the zip holds) with nothing added for tests: no extra
   host permission, no hooks. The real toolbar action is triggered through the browser's own
   debugging protocol (Extensions.triggerAction), so chrome.action.onClicked fires as for a click
   and activeTab is granted as for a click.

   The packaged build only talks to https://keepessence.app. The browser is told that this name
   lives on this machine (--host-resolver-rules) where the fake core answers over HTTPS with a
   certificate made for the test; nothing leaves the machine. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createFakeCore, MANAGE_CREDENTIAL } from '../../dev/fake-core.mjs';
import { contract, root, SECRET, startSite, until } from './helpers.mjs';

const T = { timeout: 90000 };
let core, http, site, context, id, options, session, tmp, lang, skip = '';
const say = (key) => contract['x-shared-rules'].save_messages[key][lang];
const worker = () => until('the service worker', () => context.serviceWorkers().find((w) => w.url().includes(id)));
const manage = (method, path) => fetch(http + path, { method, headers: { Authorization: `Bearer ${MANAGE_CREDENTIAL}`, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });

/** presses the extension's toolbar button on this page, as the browser does for a click */
async function clickToolbarButton(page) {
  await page.bringToFront();
  const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = targetInfos.find((t) => t.url === page.url());
  assert.ok(tab, 'the tab of this page');
  await session.send('Extensions.triggerAction', { id, targetId: tab.targetId });
}
const toast = (page) => page.locator('#keepessence-toast .text');
const expectToast = async (page, text) => {
  /* the sentence before it may still be leaving: wait for this one, then compare exactly */
  await until(`the sentence ${JSON.stringify(text)}`, async () => (await toast(page).textContent({ timeout: 500 })) === text, 20000).catch(() => {});
  assert.equal(await toast(page).textContent({ timeout: 2000 }), text);
};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ke-pkg-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=keepessence.app', '-addext', 'subjectAltName=DNS:keepessence.app', '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem')], { stdio: 'ignore' });
  } catch {
    skip = 'openssl is needed to make the test certificate';
    return;
  }
  core = createFakeCore({ publicUrl: 'https://keepessence.app' });
  http = await core.start(0);
  const tlsPort = await core.startTls({ key: readFileSync(join(tmp, 'key.pem')), cert: readFileSync(join(tmp, 'cert.pem')) });
  site = await startSite();
  const dir = join(root, 'dist');
  context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, `--host-resolver-rules=MAP keepessence.app:443 127.0.0.1:${tlsPort}`, '--ignore-certificate-errors'],
  });
  const w = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  id = new URL(w.url()).host;
  session = await context.browser().newBrowserCDPSession();
  options = await until('the options page', () => context.pages().find((p) => p.url().startsWith(`chrome-extension://${id}/options.html`)));
  await options.waitForLoadState();
  lang = await (await worker()).evaluate(() => chrome.i18n.getMessage('lang'));
}, T);

after(async () => {
  await context?.close();
  await site?.close();
  await core?.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('packaged build: connects to https://keepessence.app with its one host permission', T, async (t) => {
  if (skip) return t.skip(skip);
  const granted = await (await worker()).evaluate(() => chrome.permissions.getAll());
  assert.deepEqual(granted.origins, ['https://keepessence.app/*']);
  assert.deepEqual(granted.permissions.sort(), ['activeTab', 'contextMenus', 'notifications', 'scripting', 'storage']);
  const code = await until('a short code', async () => {
    const c = (await options.locator('#code').textContent()).trim();
    return /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(c) ? c : null;
  });
  assert.equal((await manage('POST', `/v1/device-codes/${code}/approve`)).status, 200);
  await until('the connected view', async () => (await options.locator('#connection').getAttribute('data-view')) === 'connected');
  assert.equal(await options.locator('#server-line').textContent(), await (await worker()).evaluate(() => chrome.i18n.getMessage('opt_server_at', 'https://keepessence.app')));
});

test('packaged build: a real press of the toolbar button saves the page (activeTab), then says duplicate', T, async (t) => {
  if (skip) return t.skip(skip);
  const page = await context.newPage();
  await page.goto(`${site.url}/packaged`);
  const pages = context.pages().length;
  await clickToolbarButton(page);
  await expectToast(page, say('saved'));
  assert.equal(context.pages().length, pages, 'no window, no popup');
  assert.deepEqual(core.state.items.map((i) => i.request), [{ kind: 'link', url: `${site.url}/packaged`, title: '把定时任务做成幂等的七种写法 packaged', entry: 'toolbar' }]);
  await clickToolbarButton(page);
  await expectToast(page, say('duplicate'));
  assert.equal(core.state.items.length, 1);
  await page.close();
});

test('packaged build: a selected password is asked about; "no" saves nothing', T, async (t) => {
  if (skip) return t.skip(skip);
  const page = await context.newPage();
  await page.goto(`${site.url}/packaged-secret`);
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#secret'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await clickToolbarButton(page);
  await expectToast(page, say('secret_like_question'));
  await page.locator('#keepessence-toast button[data-answer="no"]').click();
  await expectToast(page, await (await worker()).evaluate(() => chrome.i18n.getMessage('not_saved')));
  assert.equal(core.state.items.length, 1);
  assert.ok(!JSON.stringify(core.state.requests.map((r) => r.body)).includes(SECRET), 'the text never left the browser');
  await page.close();
});

test("packaged build: the browser's own page is not saved; a badge says so", T, async (t) => {
  if (skip) return t.skip(skip);
  const page = await context.newPage();
  await page.goto('chrome://version/');
  await clickToolbarButton(page);
  const w = await worker();
  await until('the badge', async () => (await w.evaluate(async () => chrome.action.getBadgeText({ tabId: (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id }))) === '!');
  assert.equal(core.state.items.length, 1);
  await page.close();
});

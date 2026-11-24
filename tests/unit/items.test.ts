import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceName, imageAsLink, menuTarget, pageRequest, serverOrigin } from '../../src/lib/items.ts';
import { scaled } from '../../src/lib/image.ts';

/* SaveRequest in the contract, additionalProperties: false */
const ALLOWED = ['kind', 'url', 'title', 'text', 'asset_id', 'entry'];
const onlyAllowed = (r: object) => assert.deepEqual(Object.keys(r).filter((k) => !ALLOWED.includes(k)), []);
const tab = { url: 'https://blog.example.dev/idempotent-cron', title: '  把定时任务做成幂等的七种写法 ' };

test('the toolbar saves the page: address, title, and the selection when there is one', () => {
  assert.deepEqual(pageRequest(tab, '', 'toolbar'), { kind: 'link', url: tab.url, title: '把定时任务做成幂等的七种写法', entry: 'toolbar' });
  assert.deepEqual(pageRequest(tab, ' 第二种是租约 \n', 'shortcut'), { kind: 'link', url: tab.url, title: '把定时任务做成幂等的七种写法', text: '第二种是租约', entry: 'shortcut' });
});

test("the browser's own pages are not web pages", () => {
  assert.equal(pageRequest({ url: 'chrome://extensions/', title: 'Extensions' }, '', 'toolbar'), null);
  assert.equal(pageRequest({}, '', 'toolbar'), null);
  assert.deepEqual(menuTarget({ menuItemId: 'save-page', pageUrl: 'chrome://settings/' }, { url: 'chrome://settings/' }), { what: 'none', why: 'not_web' });
});

test('the menu saves the thing that was pointed at', () => {
  const page = menuTarget({ menuItemId: 'save-page', pageUrl: tab.url }, tab);
  assert.deepEqual(page, { what: 'request', request: { kind: 'link', url: tab.url, title: '把定时任务做成幂等的七种写法', entry: 'context-menu' } });

  const selection = menuTarget({ menuItemId: 'save-selection', selectionText: 'flattened by the menu' }, tab, 'with\nline breaks');
  assert.deepEqual(selection, { what: 'request', request: { kind: 'text', text: 'with\nline breaks', url: tab.url, title: '把定时任务做成幂等的七种写法', entry: 'context-menu' } });
  const fallback = menuTarget({ menuItemId: 'save-selection', selectionText: 'flattened by the menu' }, tab, '');
  assert.equal(fallback.what === 'request' && fallback.request.text, 'flattened by the menu');
  assert.deepEqual(menuTarget({ menuItemId: 'save-selection' }, tab, ' '), { what: 'none', why: 'nothing' });

  const link = menuTarget({ menuItemId: 'save-link', linkUrl: 'https://example.com/outbox' }, tab);
  assert.deepEqual(link, { what: 'request', request: { kind: 'link', url: 'https://example.com/outbox', entry: 'context-menu' } });
  assert.deepEqual(menuTarget({ menuItemId: 'save-link', linkUrl: 'javascript:void(0)' }, tab), { what: 'none', why: 'not_web' });

  const image = menuTarget({ menuItemId: 'save-image', srcUrl: 'https://cdn.example.com/a.png' }, tab);
  assert.deepEqual(image, { what: 'image', srcUrl: 'https://cdn.example.com/a.png', request: { kind: 'image', url: tab.url, title: '把定时任务做成幂等的七种写法', entry: 'context-menu' } });
});

test('no request carries tags or triage information (rule B7)', () => {
  onlyAllowed(pageRequest(tab, 'x', 'toolbar')!);
  for (const id of ['save-page', 'save-selection', 'save-link', 'save-image']) {
    const target = menuTarget({ menuItemId: id, pageUrl: tab.url, linkUrl: 'https://example.com/', srcUrl: 'https://example.com/a.png', selectionText: 'x' }, tab, 'x');
    assert.notEqual(target.what, 'none');
    if (target.what !== 'none') onlyAllowed(target.request);
  }
  onlyAllowed(imageAsLink('https://cdn.example.com/a.png', 'context-menu')!);
});

test('an image that cannot be read is saved by its address, when it has one', () => {
  assert.deepEqual(imageAsLink('https://cdn.example.com/a.png', 'context-menu'), { kind: 'link', url: 'https://cdn.example.com/a.png', entry: 'context-menu' });
  assert.equal(imageAsLink('blob:https://example.com/1234', 'context-menu'), null);
});

test('titles and addresses stay within the contract', () => {
  assert.equal(pageRequest({ url: tab.url, title: 'x'.repeat(400) }, '', 'toolbar')!.title!.length, 300);
  assert.equal(pageRequest({ url: 'https://example.com/' + 'a'.repeat(2000) }, '', 'toolbar'), null);
});

test('the device names itself', () => {
  assert.equal(deviceName([{ brand: 'Chromium' }, { brand: 'Google Chrome' }], false, 'mac'), 'Chrome on Mac');
  assert.equal(deviceName([{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }], false, 'win'), 'Edge on Windows');
  assert.equal(deviceName([{ brand: 'Chromium' }], true, 'linux'), 'Brave on Linux');
  assert.equal(deviceName(undefined, false, 'cros'), 'Chromium on ChromeOS');
});

test('the address a self-hoster types', () => {
  assert.equal(serverOrigin('https://keep.example.org/some/path'), 'https://keep.example.org');
  assert.equal(serverOrigin('keep.example.org'), 'https://keep.example.org');
  assert.equal(serverOrigin(' http://127.0.0.1:8794/ '), 'http://127.0.0.1:8794');
  assert.equal(serverOrigin('ftp://example.org'), null);
  assert.equal(serverOrigin(''), null);
});

test('the long edge is brought down to the limit, never up', () => {
  assert.deepEqual(scaled(2000, 1000, 1600), { width: 1600, height: 800 });
  assert.deepEqual(scaled(900, 3600, 1600), { width: 400, height: 1600 });
  assert.deepEqual(scaled(800, 600, 1600), { width: 800, height: 600 });
});

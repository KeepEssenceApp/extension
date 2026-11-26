import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SAVE_MESSAGES } from '../../src/generated/contract.ts';

// A6 (Cheney, 2026-11-26): the user is not told that tags exist. Nothing the extension shows
// (its name, its menus, its options page, its notifications, the sentences of saving) says 标签 or "tag".
// The browser's own "标签页" (a tab) is not a tag.
const mentionsTags = (text: string) => /标签(?!页)|\btags?\b/i.test(text);
const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');

test('no entry of the locale files mentions tags (A6)', () => {
  for (const lang of ['en', 'zh_CN']) {
    const messages = JSON.parse(read(`_locales/${lang}/messages.json`)) as Record<string, { message?: string; description?: string }>;
    assert.ok(Object.keys(messages).length > 0);
    for (const [key, entry] of Object.entries(messages)) {
      assert.ok(!mentionsTags(entry.message ?? ''), `${lang} ${key}: ${entry.message}`);
      assert.ok(!mentionsTags(entry.description ?? ''), `${lang} ${key} (description): ${entry.description}`);
    }
  }
});

test('the manifest and the options page do not mention tags (A6)', () => {
  const manifest = JSON.parse(read('manifest.json')) as Record<string, unknown>;
  for (const key of ['name', 'short_name', 'description', 'action', 'commands']) {
    assert.ok(!mentionsTags(JSON.stringify(manifest[key] ?? '')), `manifest ${key}`);
  }
  const html = read('options.html').replace(/<(script|style)[\s\S]*?<\/\1>/g, '');
  const text = html.replace(/<[^>]*>/g, ' ');
  assert.ok(!mentionsTags(text), 'options.html text');
  for (const match of html.matchAll(/\b(?:title|placeholder|aria-label|alt)="([^"]*)"/g)) assert.ok(!mentionsTags(match[1] ?? ''), `options.html attribute: ${match[1]}`);
});

test('no string the code shows mentions tags (A6)', () => {
  for (const file of ['background.ts', 'options.ts', 'page.ts', 'lib/messages.ts']) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const [literal] of code.matchAll(/(['"`])(?:(?!\1)[^\\\n]|\\.)*\1/g)) assert.ok(!mentionsTags(literal), `${file}: ${literal}`);
  }
});

test('the sentences of saving do not mention tags (A6)', () => {
  assert.ok(Object.keys(SAVE_MESSAGES).length > 0);
  assert.ok(!mentionsTags(JSON.stringify(SAVE_MESSAGES)));
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { SAVE_MESSAGES } from '../../src/generated/contract.ts';
import { langOf, sentence, toneOf } from '../../src/lib/messages.ts';
import type { SharedRules } from '../../src/lib/types.ts';

const contract = parse(readFileSync(new URL('../../contract/openapi.yaml', import.meta.url), 'utf8'));
const rules = contract['x-shared-rules'] as SharedRules;

test('the browser language picks zh or en', () => {
  assert.equal(langOf('zh-CN'), 'zh');
  assert.equal(langOf('zh-TW'), 'zh');
  assert.equal(langOf('en-GB'), 'en');
  assert.equal(langOf('fr'), 'en');
  assert.equal(langOf(undefined), 'en');
});

test('the generated fallback is the contract, word for word', () => {
  for (const key of ['saved', 'duplicate', 'saved_image_skipped_quota', 'queued_offline', 'failed', 'secret_like_question']) {
    assert.deepEqual(SAVE_MESSAGES[key], (rules.save_messages as Record<string, unknown>)[key]);
  }
});

test('what the core said is what is shown', () => {
  const o = { type: 'answered', result: { status: 'saved', message_key: 'saved', message: 'The core said this.' } } as const;
  assert.equal(sentence(o, 'en', rules, SAVE_MESSAGES), 'The core said this.');
  assert.equal(toneOf(o), 'saved');
});

test('a duplicate says so', () => {
  const o = { type: 'answered', result: { status: 'duplicate', message_key: 'duplicate', message: '' } } as const;
  assert.equal(sentence(o, 'zh', rules, SAVE_MESSAGES), '之前存过了，没有重复存。');
  assert.equal(sentence(o, 'en', rules, SAVE_MESSAGES), 'Already saved. Nothing was added.');
  assert.equal(toneOf(o), 'duplicate');
});

test('an answer without a message uses its key, then its status', () => {
  const quota = { type: 'answered', result: { status: 'saved', message_key: 'saved_image_skipped_quota', message: '' } } as const;
  assert.equal(sentence(quota, 'en', rules, SAVE_MESSAGES), 'Saved. The image was not stored: storage quota exceeded.');
  const unknown = { type: 'answered', result: { status: 'saved', message_key: 'a_key_from_the_future', message: '' } } as const;
  assert.equal(sentence(unknown, 'zh', rules, SAVE_MESSAGES), '已存入。');
});

test('queued says queued, never saved', () => {
  const s = sentence({ type: 'queued' }, 'zh', rules, SAVE_MESSAGES);
  assert.equal(s, '还没存入，排着队，联网后自动存入。');
  assert.ok(!s.startsWith('已存入'));
  assert.equal(sentence({ type: 'queued' }, 'en', undefined, SAVE_MESSAGES), 'Not saved yet. Queued, and it will be saved when you are back online.');
});

test('a failure says why', () => {
  assert.equal(sentence({ type: 'failed', reason: '这个页面不是网页' }, 'zh', rules, SAVE_MESSAGES), '没存入：这个页面不是网页');
  assert.equal(sentence({ type: 'failed', reason: 'this is not a web page' }, 'en', rules, SAVE_MESSAGES), 'Not saved: this is not a web page');
});

test('the question comes from the shared rules', () => {
  assert.equal(sentence({ type: 'ask' }, 'en', rules, SAVE_MESSAGES), 'This looks like a password or a credential. Save it anyway?');
  assert.equal(toneOf({ type: 'ask' }), 'ask');
});

test('rules served by a newer core win over the built-in copy', () => {
  const newer: SharedRules = { save_messages: { queued_offline: { zh: '新的说法。', en: 'New words.' } } };
  assert.equal(sentence({ type: 'queued' }, 'en', newer, SAVE_MESSAGES), 'New words.');
  assert.equal(sentence({ type: 'failed', reason: 'x' }, 'en', newer, SAVE_MESSAGES), 'Not saved: x');
});

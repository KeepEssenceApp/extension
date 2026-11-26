import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { SAVE_MESSAGES, SAVE_NOTES } from '../../src/generated/contract.ts';
import { addNote, langOf, sentence, toneOf } from '../../src/lib/messages.ts';
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

const saved = { type: 'answered', result: { status: 'saved', message_key: 'saved', message: '' } } as const;
const duplicate = { type: 'answered', result: { status: 'duplicate', message_key: 'duplicate', message: '' } } as const;

test('the generated notes are the contract, word for word', () => {
  assert.deepEqual(Object.keys(SAVE_NOTES).sort(), ['gif_first_frame', 'image_as_link', 'image_not_saved']);
  for (const key of Object.keys(SAVE_NOTES)) assert.deepEqual(SAVE_NOTES[key], (rules.save_notes as Record<string, unknown>)[key]);
});

test('an image saved as its address says so after the sentence (B2), in both languages', () => {
  const o = { ...saved, note: 'image_as_link' } as const;
  assert.equal(sentence(o, 'zh', rules, SAVE_MESSAGES, SAVE_NOTES), '已存入。这张图片没读出来，存的是它的网址。');
  assert.equal(sentence(o, 'en', rules, SAVE_MESSAGES, SAVE_NOTES), 'Saved. The image could not be read, so its address was saved instead.');
  assert.equal(toneOf(o), 'saved');
});

test('the core\'s own sentence comes first, whatever it says', () => {
  const o = { type: 'answered', result: { status: 'saved', message_key: 'saved', message: 'The core said this.' }, note: 'image_as_link' } as const;
  assert.equal(sentence(o, 'en', rules, SAVE_MESSAGES, SAVE_NOTES), 'The core said this. The image could not be read, so its address was saved instead.');
});

test('a duplicate gets no note: nothing was added, so there is nothing to say about what was added', () => {
  const o = { ...duplicate, note: 'image_as_link' } as const;
  assert.equal(sentence(o, 'en', rules, SAVE_MESSAGES, SAVE_NOTES), 'Already saved. Nothing was added.');
});

test('queued keeps its note: what waits in the queue is the address', () => {
  assert.equal(sentence({ type: 'queued', note: 'image_as_link' }, 'zh', rules, SAVE_MESSAGES, SAVE_NOTES), '还没存入，排着队，联网后自动存入。这张图片没读出来，存的是它的网址。');
  assert.equal(sentence({ type: 'queued' }, 'zh', rules, SAVE_MESSAGES, SAVE_NOTES), '还没存入，排着队，联网后自动存入。');
});

test('a failure and a question carry no note', () => {
  assert.equal(sentence({ type: 'failed', reason: 'x' }, 'en', rules, SAVE_MESSAGES, SAVE_NOTES), 'Not saved: x');
});

test('without notes (an older core, no generated copy) the sentence is as it was; the served rules win over the generated copy', () => {
  assert.equal(sentence({ ...saved, note: 'image_as_link' }, 'en', undefined, SAVE_MESSAGES), 'Saved.');
  const served = { save_notes: { image_as_link: { zh: '改了。', en: 'Changed.' } } };
  assert.equal(sentence({ ...saved, note: 'image_as_link' }, 'en', served as never, SAVE_MESSAGES, SAVE_NOTES), 'Saved. Changed.');
  assert.equal(addNote('A', undefined, 'en', rules, SAVE_NOTES), 'A');
  assert.equal(addNote('A', 'a_note_from_the_future' as never, 'en', rules, SAVE_NOTES), 'A');
});

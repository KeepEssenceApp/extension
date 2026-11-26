import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { SAVE_MESSAGES } from '../../src/generated/contract.ts';
import { langOf, sentence, sentenceInstead, toneOf } from '../../src/lib/messages.ts';
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

/* QA #87: an image that was saved as its address says so, as it is: done once it happened, waiting while it waits */
const DONE = "Couldn't get this image, so its link was saved instead.";
const WAITING = "Couldn't get this image, so its link will be saved instead.";
const ONE_FRAME = 'Only one frame of the animation was kept.';
const said = { done: DONE, waiting: WAITING };
const saved = { type: 'answered', result: { status: 'saved', message_key: 'saved', message: 'Saved.' } } as const;

test('a save that happened says what it was instead of the core\'s plain sentence', () => {
  assert.equal(sentenceInstead(saved, 'en', rules, SAVE_MESSAGES, said), DONE);
  assert.equal(sentenceInstead(saved, 'en', rules, SAVE_MESSAGES), 'Saved.');
});

test('a save that was already there keeps the core\'s sentence, which is then the true one', () => {
  const duplicate = { type: 'answered', result: { status: 'duplicate', message_key: 'duplicate', message: '' } } as const;
  assert.equal(sentenceInstead(duplicate, 'en', rules, SAVE_MESSAGES, said), 'Already saved. Nothing was added.');
});

test('a save that waits in the queue says what WILL be saved, after the queued sentence, never the words of a save that happened', () => {
  const queued = sentence({ type: 'queued' }, 'en', rules, SAVE_MESSAGES);
  const s = sentenceInstead({ type: 'queued' }, 'en', rules, SAVE_MESSAGES, said);
  assert.equal(s, `${queued} ${WAITING}`);
  assert.ok(s.startsWith('Not saved yet.'));
  assert.ok(!s.includes(DONE));
  assert.ok(!/was saved/.test(s));
  // Only the waiting part is used while it waits: a `done` without a `waiting` adds nothing to a queued save.
  assert.equal(sentenceInstead({ type: 'queued' }, 'en', rules, SAVE_MESSAGES, { done: DONE }), queued);
});

test('a save that did not happen says only why', () => {
  const failed = { type: 'failed', reason: 'the image is too large' } as const;
  assert.equal(sentenceInstead(failed, 'en', rules, SAVE_MESSAGES, said), sentence(failed, 'en', rules, SAVE_MESSAGES));
});

test('an animation that was kept as one frame says so after the core\'s sentence, only when the save happened and stored the picture', () => {
  const only = { added: ONE_FRAME };
  assert.equal(sentenceInstead(saved, 'en', rules, SAVE_MESSAGES, only), `Saved. ${ONE_FRAME}`);
  // Not to a save that waits, that was a duplicate, that failed, or whose picture was not stored (the quota answer).
  assert.equal(sentenceInstead({ type: 'queued' }, 'en', rules, SAVE_MESSAGES, only), sentence({ type: 'queued' }, 'en', rules, SAVE_MESSAGES));
  const duplicate = { type: 'answered', result: { status: 'duplicate', message_key: 'duplicate', message: '' } } as const;
  assert.equal(sentenceInstead(duplicate, 'en', rules, SAVE_MESSAGES, only), 'Already saved. Nothing was added.');
  const failed = { type: 'failed', reason: 'x' } as const;
  assert.equal(sentenceInstead(failed, 'en', rules, SAVE_MESSAGES, only), 'Not saved: x');
  const quota = { type: 'answered', result: { status: 'saved', message_key: 'saved_image_skipped_quota', message: '' } } as const;
  assert.equal(sentenceInstead(quota, 'en', rules, SAVE_MESSAGES, only), 'Saved. The image was not stored: storage quota exceeded.');
});

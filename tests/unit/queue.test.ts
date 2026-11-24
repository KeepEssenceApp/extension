import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueue, flush, QUEUE_MAX_CHARS, QUEUE_MAX_ITEMS, type SendOutcome } from '../../src/lib/queue.ts';
import type { PendingSave } from '../../src/lib/types.ts';

const save = (key: string, text = ''): PendingSave => ({ key, request: { kind: 'link', url: `https://example.com/${key}`, ...(text ? { text } : {}) }, at: 0 });

test('a save is added once: the same key twice is one save', () => {
  let q: PendingSave[] = [];
  ({ queue: q } = enqueue(q, save('a')));
  const again = enqueue(q, save('a'));
  assert.equal(again.ok, true);
  assert.equal(again.queue.length, 1);
});

test('a full queue refuses instead of dropping silently', () => {
  let q: PendingSave[] = [];
  for (let i = 0; i < QUEUE_MAX_ITEMS; i++) ({ queue: q } = enqueue(q, save(`k${i}`)));
  const more = enqueue(q, save('one-too-many'));
  assert.equal(more.ok, false);
  assert.equal(more.queue.length, QUEUE_MAX_ITEMS);
  const big = enqueue([], save('big', 'x'.repeat(QUEUE_MAX_CHARS)));
  assert.equal(big.ok, false);
});

test('everything goes out in the order it was saved, each with its own key', async () => {
  const seen: string[] = [];
  const r = await flush([save('a'), save('b'), save('c')], async (e) => {
    seen.push(e.key);
    return { kind: 'done' };
  });
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.deepEqual([r.sent, r.remaining.length, r.stopped], [3, 0, 'empty']);
});

test('still offline: it stops at once and keeps everything, in order', async () => {
  let calls = 0;
  const r = await flush([save('a'), save('b')], async () => {
    calls++;
    return { kind: 'later' };
  });
  assert.equal(calls, 1);
  assert.deepEqual(r.remaining.map((e) => e.key), ['a', 'b']);
  assert.equal(r.stopped, 'later');
});

test('offline in the middle: what was sent is gone, the rest waits', async () => {
  const answers: SendOutcome[] = [{ kind: 'done' }, { kind: 'later' }];
  const r = await flush([save('a'), save('b'), save('c')], async () => answers.shift()!);
  assert.equal(r.sent, 1);
  assert.deepEqual(r.remaining.map((e) => e.key), ['b', 'c']);
});

test('revoked: nothing is lost, it waits for the next connection', async () => {
  const r = await flush([save('a'), save('b')], async () => ({ kind: 'unauthorized' }));
  assert.equal(r.stopped, 'unauthorized');
  assert.equal(r.remaining.length, 2);
});

test('a save the core refuses for good leaves the queue with its reason, and the rest goes on', async () => {
  const answers: SendOutcome[] = [{ kind: 'rejected', reason: 'too long' }, { kind: 'done' }];
  const r = await flush([save('a'), save('b')], async () => answers.shift()!);
  assert.deepEqual(r.rejected.map((x) => [x.entry.key, x.reason]), [['a', 'too long']]);
  assert.deepEqual([r.sent, r.remaining.length], [1, 0]);
});

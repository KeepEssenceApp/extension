/* Secret-like matching against the patterns as the contract writes them (never a copy). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { compilePattern, secretLike, unusablePatterns } from '../../src/lib/secret.ts';
import type { SecretRule } from '../../src/lib/types.ts';

const contract = parse(readFileSync(new URL('../../contract/openapi.yaml', import.meta.url), 'utf8'));
const rule = contract['x-shared-rules'].secret_like as SecretRule;

test('every pattern of the contract compiles in JavaScript', () => {
  assert.ok(rule.patterns.length >= 5);
  assert.deepEqual(unusablePatterns(rule), []);
});

test('a leading (?i) becomes the i flag', () => {
  const re = compilePattern('(?i)\\bpassword\\s*=');
  assert.ok(re);
  assert.equal(re.flags, 'i');
  assert.ok(re.test('PASSWORD ='));
  assert.equal(compilePattern('(unclosed'), null);
});

/* Made-up examples, written as repeated characters so that nothing in this file has the shape
   of a real credential: the repository's secret scanner stays on for every line. */
const hits: [string, string][] = [
  ['-----BEGIN OPENSSH PRIVATE KEY-----', 'private_key_block'],
  ['sk-' + 'a'.repeat(24), 'known_credential_prefix'],
  ['token is ghp_' + 'a'.repeat(36), 'known_credential_prefix'],
  ['AKIA' + 'A'.repeat(16), 'known_credential_prefix'],
  ['Authorization: Bearer ' + 'abcd'.repeat(6), 'bearer_or_basic_header'],
  ['PASSWORD = hunter2hunter2', 'assignment_of_secret'],
  ['api_key: ' + 'x'.repeat(12), 'assignment_of_secret'],
  ['Tr0ub4dor&3xYz', 'single_dense_string'],
];
for (const [text, name] of hits) {
  test(`asks about ${JSON.stringify(text.slice(0, 28))} (${name})`, () => assert.equal(secretLike(text, rule), name));
}

const passes = [
  '定时任务最常见的事故不是没跑，而是跑了两遍。',
  'The second way is a lease: whoever claims the work holds something that expires.',
  'https://example.com/Path/To?id=A1b2C3d4&x=1',
  'password',
  'hello world',
  '',
  '   ',
];
for (const text of passes) {
  test(`does not ask about ${JSON.stringify(text.slice(0, 28))}`, () => assert.equal(secretLike(text, rule), null));
}

test('surrounding white space does not hide a dense string', () => assert.equal(secretLike('  Tr0ub4dor&3xYz\n', rule), 'single_dense_string'));

test('text longer than max_length_checked is prose and is not checked', () => {
  const long = 'password = hunter2hunter2 ' + 'word '.repeat(60);
  assert.ok(long.trim().length > (rule.max_length_checked ?? 0));
  assert.equal(secretLike(long, rule), null);
});

test('without a rule nothing matches (the caller must not save unchecked text)', () => {
  assert.equal(secretLike('password = hunter2hunter2', undefined), null);
});

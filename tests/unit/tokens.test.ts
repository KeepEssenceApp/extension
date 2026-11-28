import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// internal-qa #107, spec e139a47 (W8): one scale of rounding for every client. src/tokens.css is a copy of
// spec/design/tokens.css. Copying only the colours and leaving the components on the old variable gave
// 14/14/14 instead of 20/14/999 on the options page (QA 7237552569), so the components are held to it too:
// the real page is measured in tests/e2e/extension.test.mjs; here the pieces that cannot be measured by a
// variable (the toast runs in the host page's shadow root and carries literals).
const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
const tokens = read('tokens.css');
const radius = (name: string): number => {
  const m = tokens.match(new RegExp(`--ke-radius${name}:\\s*(\\d+)(?:px)?\\s*;`));
  assert.ok(m?.[1] !== undefined, `--ke-radius${name} is in tokens.css`);
  return Number(m[1]);
};

test('tokens.css has the one scale of rounding of spec e139a47: 0, 8, 14, 20, 28 and a pill', () => {
  assert.equal(radius('-mark'), 0);
  assert.equal(radius('-tag'), 8);
  assert.equal(radius(''), 14);
  assert.equal(radius('-card'), 20);
  assert.equal(radius('-sheet'), 28);
  assert.equal(radius('-control'), 999);
});

test('the options page puts the card, the field and the button on the scale, not all on one variable', () => {
  const css = read('options.css');
  const rule = (selector: string) => {
    const m = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
    assert.ok(m?.[1] !== undefined, `${selector} has a rule in options.css`);
    return m[1];
  };
  assert.match(rule('.card'), /border-radius:\s*var\(--ke-radius-card\)/);
  assert.match(rule('input'), /border-radius:\s*var\(--ke-radius\)/);
  assert.match(rule('button'), /border-radius:\s*var\(--ke-radius-control\)/);
});

test('the toast in the page carries the same radii as the tokens, as literals: the box 14, the buttons a pill', () => {
  const page = read('page.ts');
  const toast = page.match(/\.toast\{[^}]*?border-radius:(\d+)px/);
  const button = page.match(/button\{all:unset[^}]*?border-radius:(\d+)px/);
  assert.ok(toast && button, 'page.ts sets a radius on the toast and on its buttons');
  assert.equal(Number(toast[1]), radius(''), 'the toast is a small block: --ke-radius');
  assert.equal(Number(button[1]), radius('-control'), 'its buttons are pills: --ke-radius-control');
  assert.ok(!/var\(--ke-/.test(page), 'no variable of ours in page.ts: the host page does not have them');
});

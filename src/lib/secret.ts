/* Secret-like content (rule B4). The patterns are never written here: they come from the
   contract's shared rules, which the core serves at GET /v1/meta. */
import type { SecretRule } from './types.ts';

export interface CompiledPattern {
  name: string;
  test: (text: string) => boolean;
}

/** The contract gives case-insensitivity as a separate `flags` field. A leading `(?i)`, which
    older copies of the contract used, is still understood. */
export function compilePattern(source: string, extraFlags = ''): RegExp | null {
  let flags = '';
  for (const f of extraFlags) if ('ims'.includes(f) && !flags.includes(f)) flags += f;
  let body = source;
  const lead = /^\(\?([a-z]+)\)/.exec(body);
  if (lead) {
    body = body.slice(lead[0].length);
    for (const f of lead[1] ?? '') if ('ims'.includes(f) && !flags.includes(f)) flags += f;
  }
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

/** The name of the first pattern the text matches, or null. Text longer than
    `max_length_checked` is prose, not a secret, and is not checked. */
export function secretLike(text: string | undefined, rule: SecretRule | undefined): string | null {
  if (!text || !rule || !Array.isArray(rule.patterns)) return null;
  const t = text.trim();
  if (!t) return null;
  const max = typeof rule.max_length_checked === 'number' ? rule.max_length_checked : Infinity;
  // Longer text is prose; only patterns marked `any_length` (a private-key block) still apply.
  const long = t.length > max;
  for (const p of rule.patterns) {
    if (long && !p.any_length) continue;
    const re = compilePattern(p.regex, p.flags);
    if (re && re.test(t)) return p.name;
  }
  return null;
}

/** Patterns of the rule this browser cannot compile. Empty means the whole rule is usable. */
export function unusablePatterns(rule: SecretRule | undefined): string[] {
  return (rule?.patterns ?? []).filter((p) => !compilePattern(p.regex, p.flags)).map((p) => p.name);
}

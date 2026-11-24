/* Secret-like content (rule B4). The patterns are never written here: they come from the
   contract's shared rules, which the core serves at GET /v1/meta. */
import type { SecretRule } from './types.ts';

export interface CompiledPattern {
  name: string;
  test: (text: string) => boolean;
}

/** The contract writes its patterns with a leading `(?i)`; JavaScript wants that as a flag. */
export function compilePattern(source: string): RegExp | null {
  let flags = '';
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
  if (t.length > max) return null;
  for (const p of rule.patterns) {
    const re = compilePattern(p.regex);
    if (re && re.test(t)) return p.name;
  }
  return null;
}

/** Patterns of the rule this browser cannot compile. Empty means the whole rule is usable. */
export function unusablePatterns(rule: SecretRule | undefined): string[] {
  return (rule?.patterns ?? []).filter((p) => !compilePattern(p.regex)).map((p) => p.name);
}

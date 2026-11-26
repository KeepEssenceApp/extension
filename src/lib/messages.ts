/* The one sentence shown when a save is done (rules B1, B2). The words are the core's: its
   `message` first, then the shared rules it served, then the copy generated from the contract
   at build time (for a browser that has never reached a core). */
import type { Bilingual, Lang, SaveResult, SharedRules } from './types.ts';

export type SaveMessages = Record<string, Bilingual | string>;

export type Outcome =
  | { type: 'answered'; result: SaveResult }
  | { type: 'queued' }
  | { type: 'failed'; reason: string }
  | { type: 'ask' };

export type Tone = 'saved' | 'duplicate' | 'queued' | 'failed' | 'ask';

export function langOf(uiLanguage: string | undefined): Lang {
  return (uiLanguage ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function pick(key: string, lang: Lang, rules: SharedRules | undefined, fallback: SaveMessages): string {
  for (const table of [rules?.save_messages, fallback]) {
    const m = table?.[key];
    if (typeof m === 'string') return m;
    if (m && typeof m[lang] === 'string') return m[lang];
  }
  return '';
}

export function sentence(o: Outcome, lang: Lang, rules: SharedRules | undefined, fallback: SaveMessages): string {
  switch (o.type) {
    case 'answered':
      return (
        o.result.message ||
        pick(o.result.message_key, lang, rules, fallback) ||
        pick(o.result.status === 'duplicate' ? 'duplicate' : 'saved', lang, rules, fallback)
      );
    case 'queued':
      return pick('queued_offline', lang, rules, fallback);
    case 'failed':
      return pick('failed', lang, rules, fallback).replace('{reason}', o.reason);
    case 'ask':
      return pick('secret_like_question', lang, rules, fallback);
  }
}

export function toneOf(o: Outcome): Tone {
  if (o.type === 'answered') return o.result.status === 'duplicate' ? 'duplicate' : 'saved';
  return o.type;
}

/**
 * The sentence for an outcome, and what was saved instead when it is not what the user pressed (an image whose bytes could
 * not be read is saved as its address). Said as it is: a save that happened says what it was, a save that waits in the
 * queue says it after the core's own sentence, and a save that was already there, or that did not happen, keeps the plain
 * sentence, which is then the true one (QA #87).
 */
export function sentenceInstead(o: Outcome, lang: Lang, rules: SharedRules | undefined, fallback: SaveMessages, instead?: string): string {
  const plain = sentence(o, lang, rules, fallback);
  if (!instead) return plain;
  if (o.type === 'answered') return o.result.status === 'saved' ? instead : plain;
  if (o.type === 'queued') return `${plain} ${instead}`;
  return plain;
}

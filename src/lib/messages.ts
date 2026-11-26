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
 * What a save says besides the core's sentence (QA #87). Each part is said only where it is true:
 *   done     what was saved when it is not what the user pressed (an image whose bytes could not be read is saved as its
 *            address): it replaces the core's sentence once the save has happened, and never for one that was already there;
 *   waiting  the same, as it is while it waits in the queue: said after the core's own "queued" sentence, worded as what
 *            will be saved, never as done;
 *   added    something more about a save that happened and stored the picture (an animation that was kept as one frame):
 *            added after the core's sentence, and not to a queued save, a duplicate, a failure or a save whose picture was
 *            not stored (the quota answer).
 */
export interface Said {
  done?: string;
  waiting?: string;
  added?: string;
}

export function sentenceInstead(o: Outcome, lang: Lang, rules: SharedRules | undefined, fallback: SaveMessages, said?: Said): string {
  const plain = sentence(o, lang, rules, fallback);
  if (!said) return plain;
  if (o.type === 'answered') {
    if (o.result.status !== 'saved') return plain;
    if (said.done) return said.done;
    return said.added && o.result.message_key === 'saved' ? `${plain} ${said.added}` : plain;
  }
  if (o.type === 'queued') return said.waiting ? `${plain} ${said.waiting}` : plain;
  return plain;
}

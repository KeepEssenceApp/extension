/* The one sentence shown when a save is done (rules B1, B2). The words are the core's: its
   `message` first, then the shared rules it served, then the copy generated from the contract
   at build time (for a browser that has never reached a core). */
import type { Bilingual, Lang, SaveResult, SharedRules } from './types.ts';

export type SaveMessages = Record<string, Bilingual | string>;

/** What was saved is not what the user gave: said after the sentence (the keys of `save_notes`). */
export type Note = 'image_as_link' | 'image_not_saved' | 'gif_first_frame';

export type Outcome =
  | { type: 'answered'; result: SaveResult; note?: Note }
  | { type: 'queued'; note?: Note }
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

/**
 * The note that follows the sentence: only after a save that was new (or is waiting to be one), never after a
 * duplicate, in the words of the shared rules, then of the generated copy. The sentence says what happened to
 * the save; the note says how what was saved differs from what the user gave (rule B2).
 */
export function addNote(text: string, note: Note | undefined, lang: Lang, rules: SharedRules | undefined, notes: SaveMessages | undefined): string {
  if (!note) return text;
  const words = pick(note, lang, { save_messages: rules?.save_notes }, notes ?? {});
  return words ? (lang === 'zh' ? `${text}${words}` : `${text} ${words}`) : text;
}

function withNote(text: string, o: Outcome, lang: Lang, rules: SharedRules | undefined, notes: SaveMessages | undefined): string {
  if (!('note' in o)) return text;
  if (o.type === 'answered' && o.result.status === 'duplicate') return text;
  return addNote(text, o.note, lang, rules, notes);
}

export function sentence(o: Outcome, lang: Lang, rules: SharedRules | undefined, fallback: SaveMessages, notes?: SaveMessages): string {
  switch (o.type) {
    case 'answered':
      return withNote(
        o.result.message ||
          pick(o.result.message_key, lang, rules, fallback) ||
          pick(o.result.status === 'duplicate' ? 'duplicate' : 'saved', lang, rules, fallback),
        o,
        lang,
        rules,
        notes,
      );
    case 'queued':
      return withNote(pick('queued_offline', lang, rules, fallback), o, lang, rules, notes);
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

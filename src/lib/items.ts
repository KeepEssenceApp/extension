/* What is sent for each thing the user can point at. Nothing here adds tags or triage
   information (rule B7): the request has only what the contract's SaveRequest lists. */
import type { SaveRequest } from './types.ts';

export type Entry = 'toolbar' | 'shortcut' | 'context-menu';

export const MENU_IDS = ['save-page', 'save-selection', 'save-link', 'save-image'] as const;
export type MenuId = (typeof MENU_IDS)[number];

export const MENUS: { id: MenuId; title: string; contexts: ['page' | 'selection' | 'link' | 'image'] }[] = [
  { id: 'save-page', title: 'menu_page', contexts: ['page'] },
  { id: 'save-selection', title: 'menu_selection', contexts: ['selection'] },
  { id: 'save-link', title: 'menu_link', contexts: ['link'] },
  { id: 'save-image', title: 'menu_image', contexts: ['image'] },
];

const TITLE_MAX = 300;
const URL_MAX = 2000;
const TEXT_MAX = 200000;

export function isWeb(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url) && url.length <= URL_MAX;
}

const clip = (s: string | undefined, max: number): string | undefined => {
  const t = (s ?? '').trim();
  return t ? t.slice(0, max) : undefined;
};

function compact(r: SaveRequest): SaveRequest {
  const out: SaveRequest = { kind: r.kind };
  if (r.url) out.url = r.url;
  if (r.title) out.title = r.title;
  if (r.text) out.text = r.text;
  if (r.asset_id) out.asset_id = r.asset_id;
  if (r.entry) out.entry = r.entry;
  return out;
}

export interface TabLike {
  url?: string;
  title?: string;
}

/** The current page, with the selection when there is one. null: not a web page. */
export function pageRequest(tab: TabLike, selection: string | undefined, entry: Entry): SaveRequest | null {
  if (!isWeb(tab.url)) return null;
  return compact({ kind: 'link', url: tab.url, title: clip(tab.title, TITLE_MAX), text: clip(selection, TEXT_MAX), entry });
}

export interface MenuInfo {
  menuItemId: string | number;
  pageUrl?: string;
  frameUrl?: string;
  linkUrl?: string;
  srcUrl?: string;
  selectionText?: string;
}

export type MenuTarget =
  | { what: 'request'; request: SaveRequest }
  | { what: 'image'; srcUrl: string; request: SaveRequest }
  | { what: 'none'; why: 'not_web' | 'nothing' };

/** What a context-menu click means. `selection` is the text read from the page (with its line
    breaks) when that worked; the menu's own flattened copy otherwise. */
export function menuTarget(info: MenuInfo, tab: TabLike, selection?: string): MenuTarget {
  const origin = isWeb(tab.url) ? tab.url : isWeb(info.pageUrl) ? info.pageUrl : undefined;
  const title = clip(tab.title, TITLE_MAX);
  const entry: Entry = 'context-menu';
  switch (info.menuItemId) {
    case 'save-page': {
      const r = pageRequest({ url: origin, title }, undefined, entry);
      return r ? { what: 'request', request: r } : { what: 'none', why: 'not_web' };
    }
    case 'save-selection': {
      const text = clip(selection, TEXT_MAX) ?? clip(info.selectionText, TEXT_MAX);
      if (!text) return { what: 'none', why: 'nothing' };
      return { what: 'request', request: compact({ kind: 'text', text, url: origin, title, entry }) };
    }
    case 'save-link': {
      if (!isWeb(info.linkUrl)) return { what: 'none', why: 'not_web' };
      return { what: 'request', request: compact({ kind: 'link', url: info.linkUrl, entry }) };
    }
    case 'save-image': {
      if (!info.srcUrl) return { what: 'none', why: 'nothing' };
      return { what: 'image', srcUrl: info.srcUrl, request: compact({ kind: 'image', url: origin, title, entry }) };
    }
    default:
      return { what: 'none', why: 'nothing' };
  }
}

/** When the bytes of an image cannot be read, its address is saved as a link instead. */
export function imageAsLink(srcUrl: string, entry: string | undefined): SaveRequest | null {
  return isWeb(srcUrl) ? compact({ kind: 'link', url: srcUrl, entry }) : null;
}

export function deviceName(brands: { brand: string }[] | undefined, isBrave: boolean, os: string): string {
  const names = (brands ?? []).map((b) => b.brand);
  const browser = isBrave ? 'Brave' : names.includes('Microsoft Edge') ? 'Edge' : names.includes('Google Chrome') ? 'Chrome' : 'Chromium';
  const system = ({ mac: 'Mac', win: 'Windows', linux: 'Linux', cros: 'ChromeOS', android: 'Android' } as Record<string, string>)[os] ?? os;
  return `${browser} on ${system}`;
}

/** `https://host[:port]` of what the user typed, or null. A bare host is taken as https. */
export function serverOrigin(input: string | undefined): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

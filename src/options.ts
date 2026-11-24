/* The options page: connecting with a short code (rule B8: the only action is pressing Allow
   in KeepEssence; the credential is never shown), then the name, the address and "disconnect".
   Nothing the user saved is shown here or anywhere in this extension. */
import * as api from './lib/api.ts';
import { deviceName, serverOrigin } from './lib/items.ts';
import { langOf } from './lib/messages.ts';
import { DEFAULT_SERVER, mayReach, originPattern, read, remove, serverAddress, write } from './lib/store.ts';
import type { DeviceCode } from './lib/types.ts';

const POLL_MS = 2000;
const t = (name: string, subs?: string | string[]) => chrome.i18n.getMessage(name, subs) || name;
const lang = langOf(chrome.i18n.getMessage('lang'));
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n ?? '');

const view = (name: 'loading' | 'connected' | 'connect' | 'grant') => ($('connection').dataset.view = name);
const show = (el: HTMLElement, text: string | null) => {
  el.hidden = text === null;
  el.textContent = text ?? '';
};

async function defaultName(): Promise<string> {
  const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] }; brave?: unknown };
  const { os } = await chrome.runtime.getPlatformInfo();
  return deviceName(nav.userAgentData?.brands, !!nav.brave, os);
}

/* ---------------------------------------------------------------- connecting */

let attempt = 0; // a newer request, or leaving this view, ends the older poll
let current: DeviceCode | null = null;

function codeState(text: string, opts: { off?: boolean; again?: boolean; danger?: boolean } = {}): void {
  const state = $('code-state');
  state.textContent = text;
  state.className = opts.danger ? 'danger' : 'hint';
  $('code').classList.toggle('off', !!opts.off);
  $('again').hidden = !opts.again;
  $<HTMLButtonElement>('approve').disabled = !!opts.off || !current;
}

async function startConnecting(): Promise<void> {
  const mine = ++attempt;
  const server = await serverAddress();
  current = null;
  view('connect');
  $('code').textContent = '';
  codeState(t('opt_code_starting'));
  const name = $<HTMLInputElement>('name').value.trim() || (await defaultName());
  const conn: api.Conn = { server, lang };
  const made = await api.createDeviceCode(conn, name.slice(0, 60));
  if (mine !== attempt) return;
  if (!made.ok) {
    codeState(t('opt_code_failed', made.message || (made.status ? String(made.status) : t('opt_unreachable'))), { again: true, danger: true });
    return;
  }
  current = made.data;
  $('code').textContent = current.code;
  const minutes = Math.max(1, Math.round((Date.parse(current.expires_at) - Date.now()) / 60000));
  codeState(t('opt_code_waiting', String(minutes)));
  void api.getMeta(conn).then((m) => (m.ok && m.data?.shared_rules ? write({ meta: { server, at: Date.now(), meta: m.data } }) : undefined));
  void poll(mine, conn, current);
}

async function poll(mine: number, conn: api.Conn, dc: DeviceCode): Promise<void> {
  while (mine === attempt) {
    if (Date.now() > Date.parse(dc.expires_at)) return ended(mine, 'opt_code_expired');
    const r = await api.pollDeviceCode(conn, dc.code, dc.poll_secret);
    if (mine !== attempt) return;
    if (r.ok && r.data.status === 'approved' && r.data.grant?.credential) {
      attempt++;
      current = null;
      /* stored, never shown: the document of this page never holds it */
      await write({ credential: r.data.grant.credential, device: { id: r.data.grant.device.id, name: r.data.grant.device.name } });
      void chrome.runtime.sendMessage({ type: 'ke-flush' }).catch(() => {});
      return;
    }
    if (r.ok && r.data.status === 'denied') return ended(mine, 'opt_code_denied');
    if (!r.ok && r.status !== 0 && r.status < 500 && r.status !== 429) return ended(mine, 'opt_code_expired'); // 410: used or expired
    await wait(POLL_MS);
  }
}

function ended(mine: number, words: string): void {
  if (mine !== attempt) return;
  attempt++;
  current = null;
  codeState(t(words), { off: true, again: true, danger: true });
}

let nudge: (() => void) | null = null;
const wait = (ms: number) =>
  new Promise<void>((ok) => {
    nudge = ok;
    setTimeout(ok, ms);
  });
/* a background tab's timers are slowed down: ask at once when the user comes back from pressing Allow */
document.addEventListener('visibilitychange', () => !document.hidden && nudge?.());
window.addEventListener('focus', () => nudge?.());

$('approve').addEventListener('click', () => {
  if (current && /^https?:\/\//i.test(current.approve_url)) void chrome.tabs.create({ url: current.approve_url });
});
$('again').addEventListener('click', () => void startConnecting());
$('name').addEventListener('change', async () => {
  const name = $<HTMLInputElement>('name').value.trim();
  if (name) await write({ deviceName: name });
  else await remove('deviceName');
  void startConnecting();
});

/* ---------------------------------------------------------------- connected */

$('disconnect').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('disconnect');
  button.disabled = true;
  show($('disconnect-error'), null);
  const server = await serverAddress();
  const { credential } = await read('credential');
  const r = await api.revokeThisDevice({ server, lang, credential });
  button.disabled = false;
  if (r.ok || r.status === 401) {
    await remove('credential', 'device'); // revoked (or it already was): the core no longer knows this browser
    return;
  }
  show($('disconnect-error'), t('opt_disconnect_failed', r.message || (r.status ? String(r.status) : t('opt_unreachable'))));
});

/* ---------------------------------------------------------------- the address */

$('grant').addEventListener('click', async () => {
  const server = await serverAddress();
  if (await chrome.permissions.request({ origins: [originPattern(server)] }).catch(() => false)) void init();
});

$('server-save').addEventListener('click', () => {
  const error = $('server-error');
  show(error, null);
  const next = serverOrigin($<HTMLInputElement>('server').value);
  if (!next) return show(error, t('opt_server_bad'));
  /* asked right here, inside the click: the browser only shows its question for a user gesture */
  const asked = next === DEFAULT_SERVER ? Promise.resolve(true) : chrome.permissions.request({ origins: [originPattern(next)] }).catch(() => false);
  void asked.then(async (granted) => {
    if (!granted) return show(error, t('opt_server_refused'));
    const was = await serverAddress();
    if (next === was) return init();
    attempt++;
    current = null;
    const { credential } = await read('credential');
    if (credential) await api.revokeThisDevice({ server: was, lang, credential }); // the old core should forget this browser
    await remove('credential', 'device', 'meta', 'queue');
    await write({ server: next });
    return init();
  });
});

/* ---------------------------------------------------------------- start */

let checked = ''; // the credential last checked with the core, so a stored change does not ask again

async function init(): Promise<void> {
  const server = await serverAddress();
  const stored = await read('credential', 'device', 'deviceName', 'queue');
  const address = $<HTMLInputElement>('server');
  if (document.activeElement !== address) address.value = server;
  const queued = stored.queue?.length ? t('opt_queued', String(stored.queue.length)) : null;
  show($('queued-line'), queued);
  show($('connect-queued-line'), queued);
  $('server-line').textContent = $('connect-server-line').textContent = t('opt_server_at', server);

  if (!(await mayReach(server))) {
    attempt++;
    current = null;
    $('grant-line').textContent = t('opt_server_grant', server);
    view('grant');
    return;
  }
  if (stored.credential) {
    attempt++;
    current = null;
    $('connected-line').textContent = t('opt_connected', stored.device?.name ?? '');
    view('connected');
    if (checked === stored.credential) return;
    checked = stored.credential;
    const me = await api.getThisDevice({ server, lang, credential: stored.credential });
    if (me.ok && me.data.device.name !== stored.device?.name) {
      await write({ device: { id: me.data.device.id, name: me.data.device.name } }); // renamed on the devices page
    } else if (!me.ok && me.status === 401) {
      await remove('credential', 'device'); // revoked on the devices page
    }
    return;
  }
  checked = '';
  const name = $<HTMLInputElement>('name');
  if (!name.value) name.value = stored.deviceName ?? (await defaultName());
  if ($('connection').dataset.view !== 'connect' || !current) await startConnecting();
}

/* the stored state is the truth: connected, revoked, queued — the page follows it */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('credential' in changes || 'device' in changes || 'queue' in changes || 'server' in changes)) void init();
});

void (async () => {
  const key = (await chrome.commands.getAll()).find((c) => c.name === 'save-page')?.shortcut;
  $('how').textContent = t('opt_how', key || t('opt_how_nokey'));
  await init();
})();

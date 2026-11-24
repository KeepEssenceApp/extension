/* What runs inside the page the user is on. Each function is put there by itself with
   chrome.scripting.executeScript after the user pressed something (activeTab), so it must not
   refer to anything outside its own body. Nothing is injected before that and nothing stays. */

export interface ToastOptions {
  tone: 'saved' | 'duplicate' | 'queued' | 'failed' | 'ask';
  text: string;
  ms: number;
  /** only for `ask` */
  askId?: string;
  yes?: string;
  no?: string;
  declined?: string;
}

/** The one sentence, bottom right, gone by itself. With tone `ask` it has two buttons and
    answers the background with { type: 'ke-answer', id, save }. */
export function showToast(o: ToastOptions): boolean {
  const ID = 'keepessence-toast';
  document.getElementById(ID)?.remove();
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  /* design tokens: black, white and greys carry it; red only for what loses data; the dot of the mark is gold */
  style.textContent = `
    .toast{box-sizing:border-box;display:flex;gap:10px;align-items:flex-start;max-width:360px;padding:12px 14px;
      border-radius:6px;border:1px solid #2C2C2C;background:#0B0B0B;color:#FFFFFF;
      font:15px/1.45 Inter,-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC","Segoe UI",sans-serif;
      opacity:0;transform:translateY(6px);transition:opacity .16s ease,transform .16s ease}
    .toast.in{opacity:1;transform:none}
    svg{flex:none;width:18px;height:18px;margin-top:2px}
    .dot{flex:none;width:8px;height:8px;margin:7px 5px 0;border-radius:50%;background:#F2877B}
    .text{overflow-wrap:anywhere}
    .row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
    button{all:unset;box-sizing:border-box;cursor:pointer;padding:5px 14px;border-radius:6px;font:inherit;font-size:13px;
      color:#FFFFFF;border:1px solid #6B6B6B}
    button.solid{color:#0B0B0B;background:#FFFFFF;border-color:#FFFFFF}
    button:focus-visible{outline:2px solid #FFFFFF;outline-offset:2px}
    @media (prefers-reduced-motion:reduce){.toast{transition:none}}`;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.dataset.tone = o.tone;
  toast.setAttribute('role', o.tone === 'ask' ? 'alertdialog' : 'status');
  toast.setAttribute('aria-live', 'polite');
  let lead: Element;
  if (o.tone === 'failed') {
    lead = document.createElement('span');
    lead.className = 'dot';
  } else {
    const NS = 'http://www.w3.org/2000/svg';
    lead = document.createElementNS(NS, 'svg');
    lead.setAttribute('viewBox', '168 152 720 720');
    lead.setAttribute('aria-hidden', 'true');
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('fill', '#FFFFFF');
    for (const points of ['204,234 306,234 532,460 430,460', '204,790 306,790 532,564 430,564']) {
      const p = document.createElementNS(NS, 'polygon');
      p.setAttribute('points', points);
      g.append(p);
    }
    for (const [x, y, w, h] of [[510, 234, 342, 72], [510, 718, 342, 72], [510, 234, 72, 226], [510, 564, 72, 226]]) {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', String(x));
      r.setAttribute('y', String(y));
      r.setAttribute('width', String(w));
      r.setAttribute('height', String(h));
      g.append(r);
    }
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', '704');
    c.setAttribute('cy', '512');
    c.setAttribute('r', '56');
    c.setAttribute('fill', '#C5A229');
    lead.append(g, c);
  }
  const body = document.createElement('div');
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = o.text;
  body.append(text);
  toast.append(lead, body);
  root.append(style, toast);
  (document.body || document.documentElement).append(host);
  requestAnimationFrame(() => toast.classList.add('in'));

  let timer = 0;
  const leave = (ms: number) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      toast.classList.remove('in');
      window.setTimeout(() => host.remove(), 200);
    }, ms);
  };
  if (o.tone !== 'ask') {
    leave(o.ms);
    return true;
  }

  const row = document.createElement('div');
  row.className = 'row';
  const no = document.createElement('button');
  no.textContent = o.no ?? '';
  no.dataset.answer = 'no';
  const yes = document.createElement('button');
  yes.textContent = o.yes ?? '';
  yes.dataset.answer = 'yes';
  yes.className = 'solid';
  row.append(no, yes);
  body.append(row);
  let done = false;
  const answer = (save: boolean) => {
    if (done) return;
    done = true;
    let sent = true;
    try {
      void chrome.runtime.sendMessage({ type: 'ke-answer', id: o.askId, save }).catch(() => {});
    } catch {
      sent = false; // the extension was reloaded under the page: nothing was sent and nothing was saved
    }
    if (save && sent) {
      host.remove(); // the result takes this place in a moment
      return;
    }
    row.remove();
    toast.dataset.tone = 'failed';
    text.textContent = o.declined ?? '';
    leave(2600);
  };
  no.addEventListener('click', () => answer(false));
  yes.addEventListener('click', () => answer(true));
  timer = window.setTimeout(() => answer(false), o.ms); // unanswered is "no", and it says so
  return true;
}

/** The selection with its line breaks (the menu's own copy has them flattened). */
export function readSelection(): string {
  return String(globalThis.getSelection?.() ?? '');
}

/** The bytes of an image as the page itself can get them (its cookies, its cache), as a data
    URL. null when the page may not read it: another site's image without CORS. */
export async function grabImage(src: string, limit: number): Promise<{ dataUrl: string } | { tooLarge: true } | null> {
  try {
    const r = await fetch(src, { cache: 'force-cache' });
    if (!r.ok) return null;
    const blob = await r.blob();
    if (!blob.size) return null;
    if (blob.size > limit) return { tooLarge: true };
    const dataUrl = await new Promise<string>((ok, no) => {
      const fr = new FileReader();
      fr.onload = () => ok(String(fr.result));
      fr.onerror = () => no(fr.error);
      fr.readAsDataURL(blob);
    });
    return { dataUrl };
  } catch {
    return null;
  }
}

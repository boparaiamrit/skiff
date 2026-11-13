// The template library sheet: search, categories, recents, and a small form
// for templates with blanks. The chat view decides how to run a template.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, pushBack } from './core.js';
import { Icon } from './icons.js';
import { CATS, FIELDS, TEMPLATES, fill, byId } from './templates.js';

const RECENT_KEY = 'skiff.tplRecent';

// a colour per group, for the icon tiles
const TINT = {
  whatsapp: '#3dff8f', music: '#ff7ab6', catchup: '#ffcc66', time: '#7ab8ff', screen: '#b48cff', device: '#9fb3a8',
  routines: '#ffb070', travel: '#5ee0d0', shopping: '#ff9b6b', social: '#7ab8ff', files: '#ffd36b', code: '#3dff8f',
  writing: '#c9a7ff', health: '#ff6b8a',
};
const tint = (cat) => `--c:${TINT[cat] || '#3dff8f'}`;
const VALUES_KEY = 'skiff.tplValues';

function load(key, dflt) {
  try { return JSON.parse(localStorage.getItem(key)) || dflt; } catch { return dflt; }
}

export function recentTemplates() {
  return load(RECENT_KEY, []).map(byId).filter(Boolean);
}

function remember(t, values) {
  const r = [t.id, ...load(RECENT_KEY, []).filter((x) => x !== t.id)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(r));
  if (values) localStorage.setItem(VALUES_KEY, JSON.stringify({ ...load(VALUES_KEY, {}), ...values }));
}

// onRun(text, title) sends it; onEdit(text) puts it in the message box.
export function LibrarySheet({ onClose, onRun, onEdit, phone, initialCat }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState(initialCat || (recentTemplates().length ? 'recent' : 'all'));
  const [open, setOpen] = useState(null); // template being filled in
  useEffect(() => pushBack(() => (open ? setOpen(null) : onClose())), [open]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s) return TEMPLATES.filter((t) => (t.title + ' ' + t.prompt + ' ' + t.cat).toLowerCase().includes(s));
    if (cat === 'recent') return recentTemplates();
    if (cat === 'all') return TEMPLATES;
    return TEMPLATES.filter((t) => t.cat === cat);
  }, [q, cat]);

  const pick = (t) => {
    if (t.fields.length) { setOpen(t); return; }
    remember(t);
    onClose();
    onRun(t.prompt, t.title);
  };

  const grouped = !q.trim() && cat === 'all';
  const cats = [['recent', 'Clock', 'Recent'], ['all', 'LayoutGrid', 'All'], ...CATS];
  return html`<div class="sheet-backdrop" onClick=${onClose}><div class="sheet tall lib" onClick=${(e) => e.stopPropagation()}>
    ${open ? html`<${TemplateForm} t=${open} onBack=${() => setOpen(null)}
        onRun=${(text, values) => { remember(open, values); onClose(); onRun(text, open.title); }}
        onEdit=${(text, values) => { remember(open, values); onClose(); onEdit(text); }} />`
    : html`
      <div class="sheet-head"><b>Things I can do</b><span class="muted small lib-count">${TEMPLATES.length}</span><div class="grow" /><button class="icon-btn" onClick=${onClose}><${Icon} name="x" /></button></div>
      <div class="lib-search"><${Icon} name="search" size=${16} /><input placeholder="Search: WhatsApp, music, alarm…" value=${q} onInput=${(e) => setQ(e.target.value)} />${q ? html`<button class="icon-btn" onClick=${() => setQ('')}><${Icon} name="x" size=${16} /></button>` : null}</div>
      ${!q.trim() ? html`<div class="lib-cats">${cats.filter((c) => c[0] !== 'recent' || recentTemplates().length).map(([id, e, label]) =>
        html`<button class=${'chip' + (cat === id ? ' on' : '')} onClick=${() => setCat(id)}><span class="ce"><${Icon} name=${e} size=${15} /></span>${label}</button>`)}</div>` : null}
      ${!phone && list.some((t) => t.needs === 'p') ? html`<div class="lib-note"><${Icon} name="hand" size=${14} /> Templates marked with a hand need phone control (Setup → Phone control).</div>` : null}
      <div class="lib-list">
        ${!list.length ? html`<div class="muted pad">Nothing matches. Try another word, or just ask in your own words.</div>` : null}
        ${grouped ? CATS.map(([id, e, label]) => html`<div class="lib-group"><div class="lib-gh" style=${tint(id)}><${Icon} name=${e} size=${15} /> ${label}</div>
            <div class="lib-grid">${TEMPLATES.filter((t) => t.cat === id).map((t) => html`<${Card} t=${t} phone=${phone} onPick=${pick} />`)}</div></div>`)
          : html`<div class="lib-grid">${list.map((t) => html`<${Card} t=${t} phone=${phone} onPick=${pick} />`)}</div>`}
      </div>`}
  </div></div>`;
}

function Card({ t, phone, onPick }) {
  return html`<button class="tpl" style=${tint(t.cat)} onClick=${() => onPick(t)}>
    <span class="tpl-e"><${Icon} name=${t.icon} size=${19} /></span>
    <span class="tpl-t">${t.title}</span>
    <span class="tpl-m">${t.needs === 'p' ? html`<span class=${'tpl-need' + (phone ? '' : ' off')} title="Uses phone control"><${Icon} name="hand" size=${12} /></span>` : null}${t.fields.length ? html`<span class="tpl-dots">…</span>` : null}</span>
  </button>`;
}

function TemplateForm({ t, onBack, onRun, onEdit }) {
  const saved = load(VALUES_KEY, {});
  const [values, setValues] = useState(() => Object.fromEntries(t.fields.map((f) => [f, saved[f] || ''])));
  const first = useRef();
  useEffect(() => { setTimeout(() => first.current && first.current.focus(), 60); }, []);
  const ready = t.fields.every((f) => (values[f] || '').trim());
  const text = fill(t.prompt, values);
  const set = (f, v) => setValues((o) => ({ ...o, [f]: v }));
  return html`<div class="tpl-form">
    <div class="sheet-head"><button class="icon-btn" onClick=${onBack} title="Back"><${Icon} name="left" size=${20} /></button><span class="tpl-e" style=${tint(t.cat)}><${Icon} name=${t.icon} size=${19} /></span><b>${t.title}</b><div class="grow" /></div>
    <div class="pad col gap">
      ${t.fields.map((f, i) => {
        const [label, ph] = FIELDS[f] || [f, ''];
        const long = f === 'notes' || f === 'message' || f === 'details';
        return html`<label class="fld"><span>${label}</span>
          ${long ? html`<textarea ref=${i === 0 ? first : null} rows="3" placeholder=${ph} value=${values[f]} onInput=${(e) => set(f, e.target.value)} />`
            : html`<input ref=${i === 0 ? first : null} placeholder=${ph} value=${values[f]} onInput=${(e) => set(f, e.target.value)}
                onKeyDown=${(e) => { if (e.key === 'Enter' && ready) onRun(text, values); }} />`}
        </label>`;
      })}
      <div class="tpl-preview">${text}</div>
      <div class="row gap">
        <button class="btn" onClick=${() => onEdit(text, values)}><${Icon} name="edit" size=${15} /> Edit first</button>
        <div class="grow" />
        <button class="btn primary" disabled=${!ready} onClick=${() => onRun(text, values)}><${Icon} name="send" size=${15} /> Ask Claude</button>
      </div>
    </div>
  </div>`;
}

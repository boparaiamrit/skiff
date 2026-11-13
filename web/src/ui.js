// Small shared controls.
import { useEffect, useState } from 'preact/hooks';
import { html, pushBack } from './core.js';
import { Icon } from './icons.js';

// Select: a button showing the current choice; tapping opens a menu with
// a check next to the selected option. Replaces the native <select>,
// which looks out of place in the Android WebView.
export function Select({ value, options, onChange, title }) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o[0] === value) || options[0];
  return html`<span class="select">
    <button class="select-btn" onClick=${() => setOpen(true)}><span>${cur[1]}</span><${Icon} name="down" size=${14} /></button>
    ${open ? html`<${SelectMenu} title=${title} value=${value} options=${options} onPick=${(v) => { setOpen(false); onChange(v); }} onClose=${() => setOpen(false)} />` : null}
  </span>`;
}

function SelectMenu({ title, value, options, onPick, onClose }) {
  useEffect(() => pushBack(onClose), []);
  return html`<div class="menu-backdrop" onClick=${onClose}><div class="menu" onClick=${(e) => e.stopPropagation()}>
    ${title ? html`<div class="menu-title">${title}</div>` : null}
    ${options.map(([v, label, hint]) => html`<button class=${'opt' + (v === value ? ' on' : '')} onClick=${() => onPick(v)}>
      <span class="opt-text"><span class="opt-label">${label}</span>${hint ? html`<span class="opt-hint">${hint}</span>` : null}</span>
      <span class="opt-check">${v === value ? html`<${Icon} name="check" size=${16} />` : null}</span>
    </button>`)}
  </div></div>`;
}

// Done: a small round check used at the end of settings rows.
export function Done() {
  return html`<span class="done-badge" aria-label="Done"><${Icon} name="check" size=${14} /></span>`;
}

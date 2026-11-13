// Terminal: xterm.js tabs attached to PTY sessions in the Linux environment.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { html, api, wsURL, store, setStore, toast, bridge, pushBack } from './core.js';
import { Icon } from './icons.js';

const T = {
  list: [],
  active: localStorage.getItem('skiff.term') || '',
  inst: new Map(), // id -> { term, fit, ws, host, exited }
  root: null,
  fontSize: +localStorage.getItem('skiff.fontSize') || 13,
  ctrl: false,
  alt: false,
  lineMode: localStorage.getItem('skiff.lineMode') === '1',
};
const subs = new Set();
const changed = () => subs.forEach((f) => f());

const THEME = {
  background: '#0b0f0c', foreground: '#dfe8e2', cursor: '#3dff8f', cursorAccent: '#0b0f0c', selectionBackground: '#2b4a37',
  black: '#1b2420', red: '#ff6b6b', green: '#3dff8f', yellow: '#f5d76e', blue: '#6cb6ff', magenta: '#d68cff', cyan: '#5ce1e6', white: '#dfe8e2',
  brightBlack: '#5b6b62', brightRed: '#ff8f8f', brightGreen: '#7dffb3', brightYellow: '#ffe89a', brightBlue: '#9ccfff', brightMagenta: '#e6b3ff', brightCyan: '#9af0f2', brightWhite: '#ffffff',
};

function rootEl() {
  if (!T.root) {
    T.root = document.createElement('div');
    T.root.className = 'term-root';
  }
  return T.root;
}

function sendRaw(id, data) {
  const i = T.inst.get(id);
  if (i && i.ws && i.ws.readyState === 1) i.ws.send(JSON.stringify({ t: 'i', d: data }));
}

function applyMods(d) {
  if (T.ctrl && d.length === 1) {
    const c = d.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
    else if (d === ' ') d = '\x00';
    T.ctrl = false;
    changed();
  }
  if (T.alt) {
    d = '\x1b' + d;
    T.alt = false;
    changed();
  }
  return d;
}

function fitActive() {
  const i = T.inst.get(T.active);
  if (!i || !i.host.offsetParent) return;
  try {
    i.fit.fit();
    if (i.ws && i.ws.readyState === 1) i.ws.send(JSON.stringify({ t: 'r', c: i.term.cols, r: i.term.rows }));
  } catch {}
}

function attach(s) {
  if (T.inst.has(s.id)) return T.inst.get(s.id);
  const host = document.createElement('div');
  host.className = 'term-host';
  rootEl().appendChild(host);
  const term = new Terminal({
    fontSize: T.fontSize,
    fontFamily: '"JetBrains Mono", "Cascadia Mono", Menlo, "DejaVu Sans Mono", "Noto Sans Mono", monospace',
    theme: THEME, cursorBlink: true, scrollback: 8000, allowProposedApi: true, macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((e, uri) => bridge.openExternal(uri)));
  const u = new Unicode11Addon();
  term.loadAddon(u);
  term.unicode.activeVersion = '11';
  term.open(host);
  const ta = term.textarea;
  if (ta) {
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('spellcheck', 'false');
  }
  const inst = { term, fit, ws: null, host, exited: s.exited };
  T.inst.set(s.id, inst);
  term.onData((d) => sendRaw(s.id, applyMods(d)));

  const connect = () => {
    const ws = new WebSocket(wsURL('/api/term/ws?id=' + encodeURIComponent(s.id)));
    ws.binaryType = 'arraybuffer';
    inst.ws = ws;
    let first = true;
    ws.onopen = () => {
      setTimeout(fitActive, 30);
    };
    ws.onmessage = (m) => {
      const b = new Uint8Array(m.data);
      if (b[0] === 0) {
        const msg = JSON.parse(new TextDecoder().decode(b.subarray(1)));
        if (msg.t === 'exit') {
          inst.exited = true;
          term.write(`\r\n\x1b[2m[process exited with code ${msg.code}]\x1b[0m\r\n`);
          changed();
        }
        return;
      }
      if (first) { term.reset(); first = false; }
      term.write(b);
    };
    ws.onclose = () => {
      if (!T.inst.has(s.id) || inst.ws !== ws) return;
      setTimeout(() => T.list.some((x) => x.id === s.id) && connect(), 1200);
    };
  };
  connect();
  return inst;
}

function show(id) {
  T.active = id;
  localStorage.setItem('skiff.term', id);
  for (const [k, i] of T.inst) i.host.style.display = k === id ? 'block' : 'none';
  changed();
  setTimeout(() => {
    fitActive();
    const i = T.inst.get(id);
    if (i && !T.lineMode) i.term.focus();
  }, 40);
}

export async function loadTerminals() {
  try {
    T.list = await api('/api/term/list');
    for (const s of T.list) attach(s);
    for (const id of [...T.inst.keys()]) if (!T.list.some((s) => s.id === id)) dispose(id);
    if (!T.list.some((s) => s.id === T.active)) T.active = T.list.length ? T.list[T.list.length - 1].id : '';
    changed();
  } catch {}
}

function dispose(id) {
  const i = T.inst.get(id);
  if (!i) return;
  T.inst.delete(id);
  try { i.ws && i.ws.close(); } catch {}
  i.term.dispose();
  i.host.remove();
}

export async function openTerminal(opts) {
  setStore({ tab: 'term' });
  const cols = Math.max(40, Math.floor((window.innerWidth - 8) / (T.fontSize * 0.6)));
  const rows = Math.max(12, Math.floor((window.innerHeight - 200) / (T.fontSize * 1.2)));
  try {
    const s = await api('/api/term/create', { cwd: store.project, cols, rows, ...opts });
    T.list.push(s);
    attach(s);
    show(s.id);
  } catch (e) {
    toast(e.message, 4000);
    if (/not installed/.test(e.message)) setStore({ tab: 'more' });
  }
}

async function closeTerminal(id) {
  await api('/api/term/close', { id }).catch(() => {});
  T.list = T.list.filter((s) => s.id !== id);
  dispose(id);
  if (T.active === id) T.active = T.list.length ? T.list[T.list.length - 1].id : '';
  if (T.active) show(T.active);
  changed();
}

function setFont(n) {
  T.fontSize = Math.max(8, Math.min(24, n));
  localStorage.setItem('skiff.fontSize', T.fontSize);
  for (const i of T.inst.values()) i.term.options.fontSize = T.fontSize;
  fitActive();
  changed();
}

const KEYS = [
  ['ESC', '\x1b'], ['TAB', '\t'], ['⇧TAB', '\x1b[Z'], ['CTRL', 'ctrl'], ['ALT', 'alt'],
  ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
  ['^C', '\x03'], ['/', '/'], ['|', '|'], ['-', '-'], ['~', '~'],
  ['HOME', '\x1b[H'], ['END', '\x1b[F'], ['PGUP', '\x1b[5~'], ['PGDN', '\x1b[6~'], ['ENTER', '\r'],
];

function ExtraKeys() {
  const press = async (v) => {
    if (v === 'ctrl') { T.ctrl = !T.ctrl; changed(); return; }
    if (v === 'alt') { T.alt = !T.alt; changed(); return; }
    sendRaw(T.active, applyMods(v));
  };
  const keep = (e) => e.preventDefault(); // keep the keyboard open
  return html`<div class="xkeys" onPointerDown=${keep}>
    ${KEYS.map(([label, v]) => html`<button class=${'xk' + ((v === 'ctrl' && T.ctrl) || (v === 'alt' && T.alt) ? ' on' : '')} onPointerDown=${keep} onClick=${() => press(v)}>${label}</button>`)}
    <button class="xk" onPointerDown=${keep} onClick=${async () => { const t = await bridge.paste(); if (t) sendRaw(T.active, t); }}>PASTE</button>
  </div>`;
}

function LineInput() {
  const [v, setV] = useState('');
  const go = () => { sendRaw(T.active, v + '\r'); setV(''); };
  return html`<div class="line-input">
    <input class="input" value=${v} placeholder="Type a line, then send (helps with keyboards that fight the terminal)" onInput=${(e) => setV(e.target.value)}
      onKeyDown=${(e) => e.key === 'Enter' && (e.preventDefault(), go())} autocapitalize="off" autocorrect="off" spellcheck="false" />
    <button class="btn primary" onClick=${go}><${Icon} name="send" size=${16} /></button>
  </div>`;
}

function NewMenu({ onClose }) {
  useEffect(() => pushBack(onClose), []);
  const pick = (opts) => { onClose(); openTerminal(opts); };
  const android = store.status && store.status.android;
  return html`<div class="menu-backdrop" onClick=${onClose}><div class="menu" onClick=${(e) => e.stopPropagation()}>
    <button class="menu-item" onClick=${() => pick({ kind: 'claude' })}><div class="mi-title">✳ Claude Code</div><div class="mi-hint">Interactive Claude Code in ${store.project}. Uses your plan's normal limits.</div></button>
    <button class="menu-item" onClick=${() => pick({ kind: 'claude', args: '--continue', title: 'claude -c' })}><div class="mi-title">✳ Continue last Claude session</div><div class="mi-hint">claude --continue</div></button>
    <button class="menu-item" onClick=${() => pick({ kind: 'shell' })}><div class="mi-title">Ubuntu shell</div><div class="mi-hint">bash in ${store.project}</div></button>
    ${android ? html`<button class="menu-item" onClick=${() => pick({ kind: 'android' })}><div class="mi-title">Android shell</div><div class="mi-hint">The phone's own /system/bin/sh, outside Ubuntu</div></button>` : null}
    <div class="menu-sep" />
    <div class="menu-row"><span>Font</span><button class="btn small" onClick=${() => setFont(T.fontSize - 1)}>A−</button><b>${T.fontSize}</b><button class="btn small" onClick=${() => setFont(T.fontSize + 1)}>A+</button></div>
    <button class="menu-item small" onClick=${() => { T.lineMode = !T.lineMode; localStorage.setItem('skiff.lineMode', T.lineMode ? '1' : '0'); changed(); onClose(); setTimeout(fitActive, 50); }}>${T.lineMode ? '✓ ' : ''}Line input box</button>
  </div></div>`;
}

export function TerminalView() {
  const [, force] = useState(0);
  const [menu, setMenu] = useState(false);
  const box = useRef();

  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    box.current.appendChild(rootEl());
    loadTerminals().then(() => T.active && show(T.active));
    const ro = new ResizeObserver(() => fitActive());
    ro.observe(box.current);
    return () => { subs.delete(f); ro.disconnect(); };
  }, []);

  return html`<div class="view term">
    <div class="tabs">
      ${T.list.map((s) => html`<div class=${'tab' + (s.id === T.active ? ' on' : '') + (T.inst.get(s.id) && T.inst.get(s.id).exited ? ' dead' : '')} onClick=${() => show(s.id)}>
        <span>${s.kind === 'claude' ? '✳ ' : ''}${s.title}</span>
        <button class="tab-x" onClick=${(e) => { e.stopPropagation(); closeTerminal(s.id); }}><${Icon} name="x" size=${13} /></button></div>`)}
      <button class="tab add" onClick=${() => setMenu(true)}><${Icon} name="plus" size=${16} /></button>
    </div>
    <div class="term-box" ref=${box}>
      ${!T.list.length ? html`<div class="empty term-empty">
        <h2>Terminal</h2>
        <p class="muted">Run the real Claude Code here. It uses your plan's normal limits. The first time, type <code>/login</code> and finish signing in in your browser.</p>
        <div class="col gap"><button class="btn primary" onClick=${() => openTerminal({ kind: 'claude' })}>✳ Start Claude Code</button>
        <button class="btn" onClick=${() => openTerminal({ kind: 'shell' })}>Open Ubuntu shell</button></div>
      </div>` : null}
    </div>
    ${T.list.length && T.lineMode ? html`<${LineInput} />` : null}
    ${T.list.length ? html`<${ExtraKeys} />` : null}
    ${menu ? html`<${NewMenu} onClose=${() => setMenu(false)} />` : null}
  </div>`;
}

window.addEventListener('resize', () => setTimeout(fitActive, 60));
if (window.visualViewport) window.visualViewport.addEventListener('resize', () => setTimeout(fitActive, 60));

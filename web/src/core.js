// Shared plumbing: API calls, the Android bridge, app-wide state and events.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);

// The floating chat bubble loads the same UI with ?mini=1.
export const MINI = new URLSearchParams(location.search).has('mini');
// The side-button assistant loads it with ?mini=1&assist=1: voice first.
export const ASSIST = new URLSearchParams(location.search).has('assist');

export async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || data || r.statusText);
  return data;
}

export function wsURL(path) {
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path;
}

// ---- Android bridge (window.SkiffBridge, injected by the app) ----
const B = () => window.SkiffBridge;
export const bridge = {
  present: () => !!B(),
  openExternal(url) {
    if (B()) B().openExternal(url);
    else window.open(url, '_blank', 'noopener');
  },
  async copy(text) {
    if (B()) return B().copyText(text);
    try { await navigator.clipboard.writeText(text); } catch {}
  },
  async paste() {
    if (B()) return B().readClipboard() || '';
    try { return await navigator.clipboard.readText(); } catch { return ''; }
  },
  call(name, ...args) {
    try { return B() && B()[name] ? B()[name](...args) : undefined; } catch (e) { console.warn(e); }
  },
};

// ---- tiny store ----
const listeners = new Set();
export const store = {
  status: null,
  tab: localStorage.getItem('skiff.tab') || 'chat',
  project: localStorage.getItem('skiff.project') || '',
  toast: null,
  sheet: null, // { title, body } modal sheet
};
export function setStore(patch) {
  Object.assign(store, patch);
  if ('tab' in patch) localStorage.setItem('skiff.tab', store.tab);
  if ('project' in patch) localStorage.setItem('skiff.project', store.project);
  listeners.forEach((f) => f());
}
export function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    listeners.add(f);
    return () => listeners.delete(f);
  }, []);
  return store;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  clearTimeout(toastTimer);
  setStore({ toast: msg });
  toastTimer = setTimeout(() => setStore({ toast: null }), ms);
}

export async function refreshStatus() {
  try {
    const s = await api('/api/status');
    const patch = { status: s };
    if (!store.project) patch.project = s.projects;
    setStore(patch);
    return s;
  } catch (e) {
    return null;
  }
}

// ---- server events (open URL requests, setup progress) ----
const eventHandlers = new Set();
export function onEvent(f) {
  eventHandlers.add(f);
  return () => eventHandlers.delete(f);
}
export function connectEvents() {
  let ws;
  const open = () => {
    ws = new WebSocket(wsURL('/api/events'));
    ws.onmessage = (m) => {
      let ev;
      try { ev = JSON.parse(m.data); } catch { return; }
      // with the bubble running two pages listen; the one in view opens links
      if (ev.type === 'open' && (MINI ? !document.hidden : !(document.hidden && bridge.call('bubbleRunning')))) {
        bridge.openExternal(ev.url);
        toast('Opened in your browser');
      }
      eventHandlers.forEach((f) => f(ev));
    };
    ws.onclose = () => setTimeout(open, 1500);
  };
  open();
}

// ---- back button: the app asks us first; return true if we handled it ----
const backStack = [];
export function pushBack(f) {
  backStack.push(f);
  return () => {
    const i = backStack.lastIndexOf(f);
    if (i >= 0) backStack.splice(i, 1);
  };
}
window.skiffBack = () => {
  const f = backStack.pop();
  if (f) { f(); return true; }
  return false;
};

export function basename(p) {
  return (p || '').replace(/\/+$/, '').split('/').pop() || '/';
}
export function joinPath(a, b) {
  if (b.startsWith('/')) return b;
  return (a.replace(/\/+$/, '') + '/' + b).replace(/\/+/g, '/');
}
export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
export function relTime(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

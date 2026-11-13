import { useState } from 'preact/hooks';
import { html, bridge } from './core.js';
import { Icon } from './icons.js';

const PORTS = [3000, 5173, 8000, 8080, 4321, 4200];

export function PreviewView() {
  const [url, setUrl] = useState(localStorage.getItem('skiff.preview') || 'http://localhost:3000');
  const [shown, setShown] = useState(localStorage.getItem('skiff.preview') || '');
  const [n, setN] = useState(0);
  const go = (u = url) => {
    if (!/^https?:\/\//.test(u)) u = 'http://' + u;
    setUrl(u);
    setShown(u);
    setN(n + 1);
    localStorage.setItem('skiff.preview', u);
  };
  return html`<div class="view preview">
    <div class="subbar">
      <input class="input url" value=${url} onInput=${(e) => setUrl(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && go()} autocapitalize="off" autocorrect="off" spellcheck="false" />
      <button class="icon-btn" onClick=${() => go()} title="Reload"><${Icon} name="refresh" /></button>
      <button class="icon-btn" onClick=${() => bridge.openExternal(shown || url)} title="Open in browser"><${Icon} name="ext" /></button>
    </div>
    <div class="ports">${PORTS.map((p) => html`<button class="chip" onClick=${() => go('http://localhost:' + p)}>:${p}</button>`)}</div>
    ${shown ? html`<iframe key=${n} class="frame" src=${shown} />` : html`<div class="empty">
      <h2>Preview</h2>
      <p class="muted">Start a dev server in the Terminal (for example <code>npm run dev</code> or <code>python3 -m http.server 8000</code>), then open its port here.</p>
    </div>`}
  </div>`;
}

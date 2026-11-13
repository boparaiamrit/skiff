import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { html, useStore, setStore, refreshStatus, connectEvents, store, MINI, ASSIST } from './core.js';
import { Icon } from './icons.js';
import { ChatView } from './chat.js';
import { TerminalView } from './terminal.js';
import { FilesView } from './files.js';
import { PreviewView } from './preview.js';
import { MoreView } from './more.js';

const TABS = [
  { id: 'chat', label: 'Chat', icon: 'chat', view: ChatView },
  { id: 'term', label: 'Terminal', icon: 'terminal', view: TerminalView },
  { id: 'files', label: 'Files', icon: 'folder', view: FilesView },
  { id: 'preview', label: 'Preview', icon: 'globe', view: PreviewView },
  { id: 'more', label: 'Setup', icon: 'gear', view: MoreView },
];

// Views stay mounted once visited, so terminals and chats keep their state.
const visited = new Set();

function App() {
  const st = useStore();
  useEffect(() => {
    refreshStatus().then((s) => {
      if (s && s.android && !s.ready) setStore({ tab: 'more' });
    });
    connectEvents();
    const t = setInterval(refreshStatus, 15000);
    return () => clearInterval(t);
  }, []);
  visited.add(st.tab);
  const needsSetup = st.status && st.status.android && !st.status.ready;
  const Sheet = st.sheet;
  return html`<div class="app">
    <main class="views">
      ${TABS.filter((t) => visited.has(t.id)).map((t) => html`<section key=${t.id} class="pane" style=${t.id === st.tab ? '' : 'display:none'}><${t.view} /></section>`)}
    </main>
    <nav class="nav">
      ${TABS.map((t) => html`<button class=${'nav-btn' + (st.tab === t.id ? ' on' : '')} onClick=${() => setStore({ tab: t.id })}>
        <${Icon} name=${t.icon} size=${21} />
        <span>${t.label}</span>
        ${t.id === 'more' && needsSetup ? html`<i class="badge" />` : null}
      </button>`)}
    </nav>
    ${Sheet ? html`<${Sheet} />` : null}
    ${st.toast ? html`<div class="toast">${st.toast}</div>` : null}
  </div>`;
}

// The floating bubble: just the chat, with its own compact header.
function MiniApp() {
  const st = useStore();
  useEffect(() => {
    refreshStatus();
    connectEvents();
    const t = setInterval(refreshStatus, 15000);
    return () => clearInterval(t);
  }, []);
  const Sheet = st.sheet;
  return html`<div class=${'app mini' + (ASSIST ? ' assist' : '')}>
    <main class="views"><section class="pane"><${ChatView} /></section></main>
    ${Sheet ? html`<${Sheet} />` : null}
    ${st.toast ? html`<div class="toast">${st.toast}</div>` : null}
  </div>`;
}

if (MINI) document.documentElement.classList.add('mini');
render(MINI ? html`<${MiniApp} />` : html`<${App} />`, document.getElementById('app'));

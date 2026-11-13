// Projects: pick or create a folder, sign in to GitHub, clone your repos.
import { useEffect, useState } from 'preact/hooks';
import { html, api, store, setStore, toast, joinPath, basename, pushBack, onEvent, bridge, relTime } from './core.js';
import { Icon } from './icons.js';

export function openProjectPicker(tab) {
  if (typeof tab !== 'string') tab = 'folders';
  setStore({ sheet: ProjectSheet, projectTab: tab });
}

function recentProjects() {
  try { return JSON.parse(localStorage.getItem('skiff.recent') || '[]'); } catch { return []; }
}

export function selectProject(p) {
  const recent = [p, ...recentProjects().filter((x) => x !== p)].slice(0, 6);
  localStorage.setItem('skiff.recent', JSON.stringify(recent));
  setStore({ project: p, sheet: null });
  toast('Project: ' + basename(p));
}

// finish clones even if the sheet was closed
onEvent((ev) => {
  if (ev.type !== 'clone') return;
  if (ev.state === 'done') {
    toast('Cloned ' + basename(ev.path));
    if (store.pendingClone === ev.path) {
      setStore({ pendingClone: null });
      selectProject(ev.path);
    }
  } else if (ev.state === 'error') toast(ev.message, 5000);
});

function ProjectSheet() {
  const tab = store.projectTab || 'folders';
  const close = () => setStore({ sheet: null });
  useEffect(() => pushBack(close), []);
  return html`<div class="sheet-backdrop" onClick=${close}><div class="sheet tall" onClick=${(e) => e.stopPropagation()}>
    <div class="sheet-head"><b>Projects</b><span class="muted small ellip">${store.project}</span><div class="grow" /><button class="icon-btn" onClick=${close}><${Icon} name="x" /></button></div>
    <div class="seg">
      <button class=${tab === 'folders' ? 'on' : ''} onClick=${() => setStore({ projectTab: 'folders' })}><${Icon} name="folder" size=${15} /> Folders</button>
      <button class=${tab === 'github' ? 'on' : ''} onClick=${() => setStore({ projectTab: 'github' })}><${Icon} name="branch" size=${15} /> GitHub</button>
    </div>
    ${tab === 'folders' ? html`<${Folders} />` : html`<${GitHub} />`}
  </div></div>`;
}

// ---- folders ---------------------------------------------------------------

function Folders() {
  const s = store.status || {};
  const root = s.projects || '/root/projects';
  const home = s.home || '/root';
  const parent = (p) => p.replace(/\/[^/]+\/?$/, '') || '/';
  const [dir, setDir] = useState(store.project && store.project.startsWith(root + '/') ? parent(store.project) : root);
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState(null);

  const load = async (d) => {
    try {
      const r = await api('/api/fs/list?path=' + encodeURIComponent(d));
      setList(r.entries.filter((e) => e.dir));
      setErr('');
    } catch (e) {
      setList([]);
      setErr(d === root ? '' : e.message);
    }
  };
  useEffect(() => {
    api('/api/fs/mkdir', { path: root }).catch(() => {}).then(() => load(dir));
  }, [dir]);

  const create = async () => {
    const name = (newName || '').trim().replace(/[^\w.@-]+/g, '-');
    if (!name) return;
    const p = joinPath(dir, name);
    try {
      await api('/api/fs/mkdir', { path: p });
      setNewName(null);
      selectProject(p);
    } catch (e) { toast(e.message); }
  };

  const crumbs = dir.split('/').filter(Boolean);
  const recent = recentProjects().filter((p) => p !== dir).slice(0, 4);
  return html`<div class="sheet-body col">
    <div class="chips pad-x">
      <button class=${'chip' + (dir === root ? ' on' : '')} onClick=${() => setDir(root)}>~/projects</button>
      <button class=${'chip' + (dir === home ? ' on' : '')} onClick=${() => setDir(home)}>Home</button>
      <button class=${'chip' + (dir === '/sdcard' ? ' on' : '')} onClick=${() => setDir('/sdcard')}>Phone storage</button>
    </div>
    ${recent.length ? html`<div class="pad-x small muted label">Recent</div>
      ${recent.map((p) => html`<button class="row-btn" onClick=${() => selectProject(p)}><${Icon} name="history" size=${16} /><span class="rb-title">${basename(p)}</span><span class="muted small ellip">${p}</span></button>`)}` : null}
    <div class="crumbs pad-x">${['/', ...crumbs].map((c, i) => html`<button class="crumb" onClick=${() => setDir(i === 0 ? '/' : '/' + crumbs.slice(0, i).join('/'))}>${c}</button>`)}</div>
    <div class="folder-list">
      ${dir !== '/' ? html`<button class="row-btn" onClick=${() => setDir(dir.replace(/\/[^/]+\/?$/, '') || '/')}><${Icon} name="up" size=${16} /><span class="rb-title muted">Up</span></button>` : null}
      ${err ? html`<div class="pad warn small">${err}${dir === '/sdcard' ? ' — grant Phone storage in Setup first.' : ''}</div>` : null}
      ${list === null ? html`<div class="pad muted">Loading…</div>` : list.map((e) => html`<div class="row-btn">
        <button class="grow row" style="gap:10px;min-width:0" onClick=${() => setDir(joinPath(dir, e.name))}><${Icon} name="folder" size=${17} class="fdir" /><span class="rb-title">${e.name}</span></button>
        <button class="btn small" onClick=${() => selectProject(joinPath(dir, e.name))}>Open</button></div>`)}
      ${list && !list.length && !err ? html`<div class="pad muted small">No folders here yet.</div>` : null}
    </div>
    <div class="sheet-foot">
      ${newName !== null ? html`<div class="row gap">
          <input class="input" autofocus placeholder="folder-name" value=${newName} onInput=${(e) => setNewName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && create()} autocapitalize="off" autocorrect="off" spellcheck="false" />
          <button class="btn primary" onClick=${create}>Create</button><button class="btn ghost" onClick=${() => setNewName(null)}>✕</button></div>`
        : html`<div class="row gap">
          <button class="btn" onClick=${() => setNewName('')}><${Icon} name="plus" size=${15} /> New folder</button>
          <button class="btn primary grow" onClick=${() => selectProject(dir)}>Open ${basename(dir)}</button></div>`}
    </div>
  </div>`;
}

// ---- GitHub ----------------------------------------------------------------

function GitHub() {
  const [st, setSt] = useState(null);
  const [login, setLogin] = useState(null); // { state, code, url, message, lines }
  const [repos, setRepos] = useState(null);
  const [repoErr, setRepoErr] = useState('');
  const [q, setQ] = useState('');
  const [url, setUrl] = useState('');
  const [clone, setClone] = useState(null); // { path, lines, state }

  const refresh = async () => {
    try {
      const s = await api('/api/git/status');
      setSt(s);
      if (s.login) setLogin((l) => ({ lines: [], ...(l || {}), ...s.login }));
      else if (s.loginBusy) setLogin((l) => l || { state: 'working', message: 'Starting GitHub sign-in…', lines: [] });
      if (s.signedIn) loadRepos();
    } catch (e) { setSt({ error: e.message }); }
  };
  const loadRepos = async (force) => {
    setRepoErr('');
    try { setRepos(await api('/api/git/repos' + (force ? '?refresh=1' : ''))); } catch (e) { setRepoErr(e.message); setRepos([]); }
  };

  useEffect(() => {
    refresh();
    return onEvent((ev) => {
      if (ev.type === 'gitlogin') {
        setLogin((l) => {
          const cur = l || { lines: [] };
          if (ev.state === 'log') return { ...cur, lines: [...cur.lines, ev.line].slice(-30) };
          return { ...cur, ...ev };
        });
        if (ev.state === 'done') { toast('Signed in to GitHub'); setLogin(null); refresh(); }
      }
      if (ev.type === 'clone') {
        setClone((c) => {
          if (!c || c.path !== ev.path) return c;
          if (ev.state === 'running') return { ...c, lines: [...c.lines, ev.line].slice(-6) };
          return { ...c, state: ev.state, message: ev.message };
        });
      }
    });
  }, []);

  const startLogin = async () => {
    setLogin({ state: 'working', message: 'Starting…', lines: [] });
    try { await api('/api/git/login', {}); } catch (e) { setLogin({ state: 'error', message: e.message, lines: [] }); }
  };
  const logout = async () => {
    if (!confirm('Sign out of GitHub on this phone?')) return;
    try { await api('/api/git/logout', {}); } catch (e) { toast(e.message); }
    setRepos(null);
    refresh();
  };
  const doClone = async (body) => {
    try {
      const r = await api('/api/git/clone', body);
      if (r.existing) { selectProject(r.path); return; }
      setStore({ pendingClone: r.path });
      setClone({ path: r.path, lines: [], state: 'running' });
    } catch (e) { toast(e.message, 4000); }
  };

  const ready = store.status && store.status.ready;
  if (!ready) return html`<div class="sheet-body pad muted">Finish Setup first. GitHub tools run inside the Linux environment.</div>`;
  if (!st) return html`<div class="sheet-body pad muted">Checking GitHub…</div>`;

  if (clone) {
    return html`<div class="sheet-body pad col gap">
      <h3 style="margin:0">${clone.state === 'error' ? 'Clone failed' : clone.state === 'done' ? 'Cloned' : 'Cloning…'} ${basename(clone.path)}</h3>
      ${clone.state === 'running' ? html`<div class="progress"><div class="bar indet" /></div>` : null}
      <pre class="log">${clone.lines.join('\n')}${clone.message ? '\n' + clone.message : ''}</pre>
      <div class="row gap">${clone.state === 'done' ? html`<button class="btn primary" onClick=${() => selectProject(clone.path)}>Open project</button>` : null}
        <button class="btn ghost" onClick=${() => setClone(null)}>${clone.state === 'running' ? 'Continue in background' : 'Back'}</button></div>
    </div>`;
  }

  if (!st.signedIn) {
    return html`<div class="sheet-body pad col gap">
      ${!login || login.state === 'error' ? html`
        <p class="muted">Sign in once to clone private repos and push from this phone. Skiff uses the official GitHub CLI (<code>gh</code>); your token stays inside the app's Linux environment.</p>
        ${login && login.state === 'error' ? html`<div class="warn small">${login.message}</div>` : null}
        <button class="btn primary" onClick=${startLogin}><${Icon} name="branch" size=${16} /> Sign in with GitHub</button>`
      : login.state === 'code' ? html`
        <p>1. Copy this code:</p>
        <button class="device-code" onClick=${() => { bridge.copy(login.code); toast('Code copied'); }}>${login.code}</button>
        <p>2. Paste it on GitHub and approve Skiff's access:</p>
        <button class="btn primary" onClick=${() => { bridge.copy(login.code); bridge.openExternal(login.url); }}><${Icon} name="ext" size=${16} /> Copy code & open GitHub</button>
        <div class="row gap muted small"><span class="spin" /> Waiting for you to approve on github.com…</div>`
      : html`<div class="row gap"><span class="spin" /> ${login.message || 'Working…'}</div>`}
      ${login && login.lines && login.lines.length ? html`<details><summary class="muted small">Details</summary><pre class="log">${login.lines.join('\n')}</pre></details>` : null}
      <div class="menu-sep" />
      <${CloneURL} url=${url} setUrl=${setUrl} onClone=${(u) => doClone({ url: u })} />
    </div>`;
  }

  const ql = q.toLowerCase();
  const shown = (repos || []).filter((r) => !ql || r.full.toLowerCase().includes(ql) || (r.desc || '').toLowerCase().includes(ql));
  const u = st.user || {};
  return html`<div class="sheet-body col">
    <div class="gh-user pad-x">
      ${u.avatar ? html`<img src=${u.avatar} />` : null}
      <div class="grow"><b>${u.name || u.login}</b><div class="muted small">@${u.login}</div></div>
      <button class="icon-btn" title="Refresh" onClick=${() => loadRepos(true)}><${Icon} name="refresh" /></button>
      <button class="btn small ghost" onClick=${logout}>Sign out</button>
    </div>
    <div class="pad-x"><input class="input" placeholder="Search your repositories" value=${q} onInput=${(e) => setQ(e.target.value)} autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
    <div class="folder-list">
      ${repos === null ? html`<div class="pad muted row gap"><span class="spin" /> Loading repositories…</div>` : null}
      ${repoErr ? html`<div class="pad warn small">${repoErr}</div>` : null}
      ${shown.map((r) => html`<button class="repo" onClick=${() => doClone({ repo: r.full })}>
        <div class="repo-top"><span class="repo-name"><span class="muted">${r.owner}/</span>${r.name}</span>${r.private ? html`<span class="tag">private</span>` : null}${r.fork ? html`<span class="tag">fork</span>` : null}</div>
        ${r.desc ? html`<div class="repo-desc">${r.desc}</div>` : null}
        <div class="repo-meta">${r.updated ? 'updated ' + relTime(Date.parse(r.updated) / 1000) : ''}</div>
      </button>`)}
      ${repos && !shown.length && !repoErr ? html`<div class="pad muted small">No matching repositories.</div>` : null}
    </div>
    <div class="sheet-foot"><${CloneURL} url=${url} setUrl=${setUrl} onClone=${(x) => doClone({ url: x })} /></div>
  </div>`;
}

function CloneURL({ url, setUrl, onClone }) {
  return html`<div class="row gap">
    <input class="input" placeholder="Or clone any URL: https://github.com/user/repo" value=${url} onInput=${(e) => setUrl(e.target.value)}
      onKeyDown=${(e) => e.key === 'Enter' && url.trim() && onClone(url.trim())} autocapitalize="off" autocorrect="off" spellcheck="false" />
    <button class="btn" disabled=${!url.trim()} onClick=${() => onClone(url.trim())}>Clone</button>
  </div>`;
}

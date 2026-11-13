// Files: browse the Linux environment and edit files with CodeMirror.
import { useEffect, useRef, useState } from 'preact/hooks';
import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { html as htmlLang } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html, api, store, setStore, toast, joinPath, basename, pushBack } from './core.js';
import { Icon } from './icons.js';
import { openTerminal } from './terminal.js';

function langFor(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return javascript({ jsx: true });
  if (['ts', 'tsx', 'mts'].includes(ext)) return javascript({ jsx: ext === 'tsx', typescript: true });
  if (ext === 'py') return python();
  if (ext === 'rs') return rust();
  if (['html', 'htm', 'vue', 'svelte'].includes(ext)) return htmlLang();
  if (['css', 'scss', 'less'].includes(ext)) return css();
  if (['json', 'jsonc'].includes(ext)) return json();
  if (['md', 'mdx', 'markdown'].includes(ext)) return markdown();
  return [];
}

const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

function Editor({ path, onClose }) {
  const host = useRef();
  const view = useRef();
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState('loading');
  const save = async () => {
    try {
      await api('/api/fs/write', { path, content: view.current.state.doc.toString() });
      setDirty(false);
      toast('Saved');
    } catch (e) { toast('Save failed: ' + e.message); }
  };
  useEffect(() => {
    let alive = true;
    const unback = pushBack(onClose);
    if (IMG.test(path)) { setState('image'); return unback; }
    api('/api/fs/read?path=' + encodeURIComponent(path)).then((r) => {
      if (!alive) return;
      if (r.binary || r.tooLarge) { setState(r.binary ? 'binary' : 'large'); return; }
      setState('ok');
      view.current = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: r.content,
          extensions: [basicSetup, oneDark, langFor(path), EditorView.lineWrapping,
            keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { save(); return true; } }]),
            EditorView.updateListener.of((u) => u.docChanged && setDirty(true))],
        }),
      });
    }).catch((e) => setState('error: ' + e.message));
    return () => { alive = false; unback(); view.current && view.current.destroy(); };
  }, [path]);
  return html`<div class="editor">
    <div class="subbar">
      <button class="icon-btn" onClick=${onClose}><${Icon} name="x" /></button>
      <div class="sub-title">${basename(path)}${dirty ? ' •' : ''}</div>
      ${state === 'ok' ? html`<button class="btn small primary" onClick=${save} disabled=${!dirty}>Save</button>` : null}
    </div>
    ${state === 'image' ? html`<div class="img-view"><img src=${'/api/fs/read?raw=1&path=' + encodeURIComponent(path)} /></div>` : null}
    ${state !== 'ok' && state !== 'image' ? html`<div class="pad muted">${state === 'loading' ? 'Loading…' : state === 'binary' ? 'Binary file' : state === 'large' ? 'File is too large to edit here' : state}</div>` : null}
    <div class="cm-host" ref=${host} />
  </div>`;
}

export function FilesView() {
  const st = useStore2();
  const [dir, setDir] = useState(store.filesDir || store.project);
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [hidden, setHidden] = useState(false);
  const [edit, setEdit] = useState(null);
  const [menuFor, setMenuFor] = useState(null);

  const load = async (d = dir) => {
    try {
      const r = await api('/api/fs/list?path=' + encodeURIComponent(d) + (hidden ? '&hidden=1' : ''));
      setList(r.entries);
      setErr('');
      setDir(r.path);
      store.filesDir = r.path;
    } catch (e) { setErr(e.message); setList([]); }
  };
  useEffect(() => { load(); }, [dir, hidden]);
  useEffect(() => { setDir(st.project); }, [st.project]);

  const up = () => setDir(dir.replace(/\/[^/]+\/?$/, '') || '/');
  const crumbs = dir.split('/').filter(Boolean);

  const create = async (isDir) => {
    const name = prompt(isDir ? 'New folder name' : 'New file name');
    if (!name) return;
    const p = joinPath(dir, name);
    try {
      if (isDir) await api('/api/fs/mkdir', { path: p });
      else { await api('/api/fs/write', { path: p, content: '' }); setEdit(p); }
      load();
    } catch (e) { toast(e.message); }
  };
  const rename = async (e) => {
    const name = prompt('Rename to', e.name);
    if (!name || name === e.name) return;
    try { await api('/api/fs/rename', { from: joinPath(dir, e.name), to: joinPath(dir, name) }); load(); } catch (x) { toast(x.message); }
  };
  const del = async (e) => {
    if (!confirm(`Delete ${e.name}${e.dir ? ' and everything in it' : ''}?`)) return;
    try { await api('/api/fs/delete', { path: joinPath(dir, e.name) }); load(); } catch (x) { toast(x.message); }
  };

  if (edit) return html`<${Editor} path=${edit} onClose=${() => { setEdit(null); load(); }} />`;
  return html`<div class="view files">
    <div class="subbar">
      <button class="icon-btn" onClick=${up} title="Up"><${Icon} name="up" /></button>
      <div class="crumbs">${['/', ...crumbs].map((c, i) => html`<button class="crumb" onClick=${() => setDir(i === 0 ? '/' : '/' + crumbs.slice(0, i).join('/'))}>${c}</button>`)}</div>
      <button class="icon-btn" onClick=${() => load()} title="Refresh"><${Icon} name="refresh" /></button>
    </div>
    <div class="toolbar">
      <button class="btn small" onClick=${() => create(false)}><${Icon} name="file" size=${14} /> File</button>
      <button class="btn small" onClick=${() => create(true)}><${Icon} name="folder" size=${14} /> Folder</button>
      <button class="btn small" onClick=${() => openTerminal({ kind: 'shell', cwd: dir })}><${Icon} name="terminal" size=${14} /> Here</button>
      <button class="btn small" onClick=${() => { setStore({ project: dir, tab: 'chat' }); toast('Project: ' + basename(dir)); }}><${Icon} name="chat" size=${14} /> Use as project</button>
      <label class="chk"><input type="checkbox" checked=${hidden} onChange=${(e) => setHidden(e.target.checked)} /> hidden</label>
    </div>
    <div class="flist">
      ${err ? html`<div class="pad warn">${err}</div>` : null}
      ${list === null ? html`<div class="pad muted">Loading…</div>` : list.map((e) => html`<div class="frow">
        <button class="fmain" onClick=${() => (e.dir ? setDir(joinPath(dir, e.name)) : setEdit(joinPath(dir, e.name)))}>
          <${Icon} name=${e.dir ? 'folder' : 'file'} size=${17} class=${e.dir ? 'fdir' : ''} />
          <span class="fname">${e.name}${e.link ? ' ↪' : ''}</span>
          ${!e.dir ? html`<span class="fsize">${fmtSize(e.size)}</span>` : null}
        </button>
        <button class="icon-btn" onClick=${() => setMenuFor(menuFor === e.name ? null : e.name)}><${Icon} name="menu" size=${16} /></button>
        ${menuFor === e.name ? html`<div class="fmenu"><button class="btn small" onClick=${() => { setMenuFor(null); rename(e); }}>Rename</button><button class="btn small danger" onClick=${() => { setMenuFor(null); del(e); }}>Delete</button></div>` : null}
      </div>`)}
      ${list && !list.length && !err ? html`<div class="pad muted">Empty folder</div>` : null}
    </div>
  </div>`;
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1 << 20) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1 << 20)).toFixed(1) + ' MB';
}

import { useStore } from './core.js';
const useStore2 = useStore;

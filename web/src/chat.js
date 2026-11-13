// Chat: an extension-style conversation view over Claude Code's headless
// stream-json mode, with tool cards, inline diffs and permission prompts.
import { useEffect, useRef, useState } from 'preact/hooks';
import { diffLines } from 'diff';
import { html, api, wsURL, store, setStore, useStore, toast, bridge, uid, basename, relTime, pushBack, MINI, ASSIST } from './core.js';
import { Icon } from './icons.js';
import { Markdown } from './md.js';
import { openProjectPicker } from './projects.js';
import { LibrarySheet } from './library.js';
import { TEMPLATES, byId } from './templates.js';
import { V, onVoice, startListening, stopListening, cancelListening, speak, stopSpeaking, speakable, setVoicePref } from './voice.js';

const MODES = [
  { id: 'default', label: 'Ask before edits', short: 'Ask', hint: 'Claude asks before editing files or running commands' },
  { id: 'acceptEdits', label: 'Edit automatically', short: 'Auto-edit', hint: 'File edits are applied without asking; commands still ask' },
  { id: 'plan', label: 'Plan mode', short: 'Plan', hint: 'Claude explores and proposes a plan without changing anything' },
  { id: 'bypassPermissions', label: 'Bypass permissions', short: 'Bypass', hint: 'Everything runs without asking. Use with care.' },
];
const MODELS = [
  { id: '', label: 'Default model' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

// ---------------------------------------------------------------------------
// Chat state lives outside components so it survives tab switches.

const listeners = new Set();
const S = {
  id: localStorage.getItem('skiff.chat') || uid(),
  ws: null,
  connected: false,
  items: [],
  live: null,
  tools: new Map(),
  keys: new Set(),
  busy: false,
  running: false,
  sessionId: '',
  mode: localStorage.getItem('skiff.mode') || 'default',
  model: localStorage.getItem('skiff.model') || '',
  cwd: '',
  stderr: [],
  title: '',
  pendingConfig: null,
  slash: null, // slash commands reported by Claude Code
  ctx: null, // { used, window } context usage
};
// quick picks on the empty screen (templates without blanks)
const CODE_SUGS = ['cd-explain', 'cd-bug', 'cd-tests', 'cd-gh'];
const PHONE_SUGS = ['wa-waiting', 'cu-notifs', 'mu-liked', 'sc-what'];

// ---- templates: run one, or put it in the message box to edit first
let composerSet = null;
export function runTemplate(text, title) {
  if (!S.title) S.title = title;
  send({ t: 'send', content: [{ type: 'text', text }] });
  changed();
}
export function openLibrary(cat) {
  const close = () => setStore({ sheet: null });
  const phone = !!(store.status && store.status.phone) && !!bridge.call('phoneControlOn');
  setStore({ sheet: () => html`<${LibrarySheet} initialCat=${cat} phone=${phone} onClose=${close} onRun=${runTemplate}
    onEdit=${(t) => { if (composerSet) composerSet(t); }} />` });
}
const DEFAULT_SLASH = ['compact', 'init', 'review', 'security-review', 'pr-comments', 'context', 'cost', 'release-notes'];
localStorage.setItem('skiff.chat', S.id);

// Like a phone assistant: opening it after a while starts a fresh
// conversation; opening it again soon continues the last one.
const FRESH_AFTER = 10 * 60 * 1000;
const lastActive = () => +localStorage.getItem('skiff.lastActive') || 0;
if (ASSIST && Date.now() - lastActive() > FRESH_AFTER) {
  S.id = uid();
  localStorage.setItem('skiff.chat', S.id);
}

let raf = 0;
function changed() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    listeners.forEach((f) => f());
  });
}

function send(msg) {
  if (msg.t === 'send') localStorage.setItem('skiff.lastActive', String(Date.now()));
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg));
  else if (msg.t === 'send') { (S.queue = S.queue || []).push(msg); toast('Connecting…'); }
  else toast('Not connected yet');
}

function resetItems() {
  S.items = [];
  S.live = null;
  S.tools = new Map();
  S.keys = new Set();
  S.stderr = [];
}

function connect() {
  if (S.ws) S.ws.close();
  const ws = new WebSocket(wsURL('/api/chat/ws?id=' + encodeURIComponent(S.id)));
  S.ws = ws;
  ws.onopen = () => {
    S.connected = true;
    send({ t: 'config', cwd: S.cwd || store.project, mode: S.mode, model: S.model, ...(S.pendingConfig || {}) });
    S.pendingConfig = null;
    const q = S.queue || [];
    S.queue = [];
    q.forEach(send);
    changed();
  };
  ws.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.connected = false;
    changed();
    setTimeout(() => S.ws === ws && connect(), 1500);
  };
}

function pushItem(it) {
  S.items.push(it);
}

function handle(msg) {
  switch (msg.t) {
    case 'replay_end':
      S.replaying = false;
      break;
    case 'replay_start':
      S.replaying = true;
      // rebuild from scratch: a resumed transcript first, then this process's events
      resetItems();
      if (S.history) applyHistory(S.history);
      break;
    case 'status':
      if (MINI && !ASSIST && !!msg.busy !== S.busy) bridge.call('bubbleBusy', !!msg.busy); // the bubble's ring spins while Claude works
      S.busy = msg.busy;
      S.running = msg.running;
      S.sessionId = msg.sessionId || '';
      if (msg.mode) S.mode = msg.mode;
      S.model = msg.model || '';
      S.cwd = msg.cwd || S.cwd;
      break;
    case 'user':
      pushItem({ k: 'user', content: msg.content, ts: msg.ts });
      break;
    case 'ev':
      handleEvent(msg.ev);
      break;
    case 'approval':
      pushItem({ k: 'approval', id: msg.id, tool: msg.tool, input: msg.input || {}, state: 'pending' });
      if (VM.on && !S.replaying) { cancelListening(); stopSpeaking(); VM.phase = 'input'; }
      if (!S.replaying && MINI) bridge.call('setBadge', 'input'); // the bubble opens itself
      else if (!S.replaying && document.hidden && !bridge.call('bubbleRunning')) {
        const q = msg.tool === 'AskUserQuestion';
        bridge.call('notify', q ? 'Claude has a question' : 'Claude needs your approval', q ? toolSummary(msg.tool, msg.input || {}) : `${toolLabel(msg.tool)}: ${toolSummary(msg.tool, msg.input || {})}`);
      }
      break;
    case 'approval_done': {
      const it = S.items.find((x) => x.k === 'approval' && x.id === msg.id);
      if (it) {
        it.state = msg.allow ? (msg.always ? 'always' : 'allowed') : 'denied';
        if (msg.answers) it.answers = msg.answers;
      }
      break;
    }
    case 'stderr':
      S.stderr.push(msg.line);
      if (S.stderr.length > 200) S.stderr.shift();
      break;
    case 'exit':
      S.busy = false;
      if (msg.code && !msg.expected) {
        const why = msg.code === 137 ? 'Android stopped Claude Code (out of memory or background limits).'
          : msg.code === 143 ? 'Claude Code was stopped.'
          : `Claude Code stopped unexpectedly (exit code ${msg.code}).`;
        pushItem({ k: 'error', message: why + ' Send a message to continue where you left off.', detail: S.stderr.filter((l) => l.trim()).slice(-12).join('\n') });
      }
      break;
    case 'interrupted':
      pushItem({ k: 'system', text: 'Stopped' });
      break;
    case 'restore':
      if (!S.items.length && msg.sessionId) restoreSession(msg.sessionId, msg.cwd);
      break;
    case 'error':
      pushItem({ k: 'error', message: msg.message });
      break;
  }
  changed();
}

function handleEvent(ev) {
  const parent = ev.parent_tool_use_id || null;
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        if (Array.isArray(ev.slash_commands) && ev.slash_commands.length) S.slash = ev.slash_commands.map((c) => String(c).replace(/^\//, ''));
        const key = 'init:' + ev.session_id;
        if (!S.keys.has(key)) {
          S.keys.add(key);
          pushItem({ k: 'system', text: `Session started · ${ev.model || 'model'} · ${ev.permissionMode || ''}`.replace(/ · $/, '') });
        }
      } else if (ev.subtype === 'compact_boundary') {
        pushItem({ k: 'system', text: 'Conversation compacted' });
      }
      break;
    case 'stream_event':
      if (!parent) handleStream(ev.event);
      break;
    case 'assistant':
      addAssistant(ev.message, parent);
      break;
    case 'user':
      addToolResults(ev.message, parent);
      break;
    case 'result': {
      S.busy = false;
      S.live = null;
      pushItem({ k: 'result', data: ev });
      if (MINI && !S.replaying) bridge.call('setBadge', 'done');
      const mu = ev.modelUsage && Object.values(ev.modelUsage)[0];
      if (mu && mu.contextWindow) S.ctx = { ...(S.ctx || { used: 0 }), window: mu.contextWindow };
      if (VM.on && VM.waitTurn && !S.replaying) setTimeout(vmOnResult, 0);
      break;
    }
  }
}

function handleStream(e) {
  if (!e) return;
  if (e.type === 'message_start') S.live = { id: e.message && e.message.id, blocks: {}, final: 0 };
  if (!S.live) return;
  if (e.type === 'content_block_start') S.live.blocks[e.index] = { type: e.content_block.type, text: '', name: e.content_block.name };
  if (e.type === 'content_block_delta') {
    const b = S.live.blocks[e.index];
    if (!b) return;
    const d = e.delta || {};
    if (d.type === 'text_delta') b.text += d.text;
    else if (d.type === 'thinking_delta') b.text += d.thinking;
    else if (d.type === 'input_json_delta') b.text += d.partial_json;
  }
}

function addAssistant(message, parent) {
  if (!message || !Array.isArray(message.content)) return;
  const u = message.usage;
  if (u && !parent) {
    const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    if (used) S.ctx = { window: 200000, ...(S.ctx || {}), used };
  }
  const mid = message.id || uid();
  let n = 0;
  for (const b of message.content) {
    n++;
    if (b.type === 'tool_use') {
      if (S.tools.has(b.id)) continue;
      const it = { k: 'tool', id: b.id, name: b.name, input: b.input || {}, result: null, children: [] };
      S.tools.set(b.id, it);
      const p = parent && S.tools.get(parent);
      if (p) p.children.push(it);
      else pushItem(it);
      continue;
    }
    if (parent) continue; // subagent prose stays inside its tool card
    const text = b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : '';
    if (!text) continue;
    const key = mid + ':' + b.type + ':' + text.length + ':' + text.slice(0, 40);
    if (S.keys.has(key)) continue;
    S.keys.add(key);
    pushItem({ k: b.type === 'thinking' ? 'thinking' : 'text', text });
  }
  if (S.live && S.live.id === mid) {
    S.live.final += n;
    for (const i of Object.keys(S.live.blocks)) if (+i < S.live.final) delete S.live.blocks[i];
  }
}

function addToolResults(message, parent) {
  if (!message || !Array.isArray(message.content)) return;
  for (const b of message.content) {
    if (b.type !== 'tool_result') continue;
    const it = S.tools.get(b.tool_use_id);
    if (!it) continue;
    let text = '';
    if (typeof b.content === 'string') text = b.content;
    else if (Array.isArray(b.content)) text = b.content.map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean).join('\n');
    const images = Array.isArray(b.content) ? b.content.filter((c) => c.type === 'image' && c.source && c.source.data).map((c) => 'data:' + (c.source.media_type || 'image/jpeg') + ';base64,' + c.source.data) : [];
    it.result = { text, images, isError: !!b.is_error };
  }
}

// Load a past transcript into the view (when resuming a session).
function loadHistory(entries) {
  S.history = entries;
  resetItems();
  applyHistory(entries);
  changed();
}

function applyHistory(entries) {
  for (const e of entries) {
    if (e.type === 'user') {
      const c = e.message && e.message.content;
      if (typeof c === 'string') pushItem({ k: 'user', content: [{ type: 'text', text: c }] });
      else if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) addToolResults(e.message, null);
      else if (Array.isArray(c)) {
        const blocks = c.filter((b) => b.type === 'text' || b.type === 'image');
        const t = blocks.map((b) => b.text || '').join('');
        if (blocks.length && !t.startsWith('<')) pushItem({ k: 'user', content: blocks });
      }
    } else if (e.type === 'assistant') addAssistant(e.message, null);
  }
}

// The app and the bubble are two pages sharing localStorage: when one of
// them switches conversation, the other follows next time it is shown.
function syncChat() {
  const id = localStorage.getItem('skiff.chat');
  const proj = localStorage.getItem('skiff.project');
  if (proj && proj !== store.project) {
    S.cwd = proj;
    setStore({ project: proj });
  }
  if (!id || id === S.id) return;
  S.id = id;
  resetItems();
  S.sessionId = '';
  S.title = '';
  S.history = null;
  S.pendingConfig = null;
  S.cwd = store.project;
  connect();
  changed();
}
window.addEventListener('skiff-resume', syncChat);
window.addEventListener('storage', (e) => { if (e.key === 'skiff.chat' || e.key === 'skiff.project') syncChat(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncChat(); });

export function newChat(opts = {}) {
  if (S.running) send({ t: 'stop' });
  S.id = uid();
  localStorage.setItem('skiff.chat', S.id);
  resetItems();
  S.sessionId = '';
  S.title = '';
  S.history = null;
  S.pendingConfig = opts.resume ? { resume: opts.resume } : null;
  S.cwd = store.project;
  connect();
  changed();
}

async function restoreSession(id, cwd) {
  try {
    const hist = await api('/api/chat/history?cwd=' + encodeURIComponent(cwd || store.project) + '&id=' + encodeURIComponent(id));
    if (S.items.length) return;
    loadHistory(hist);
    const first = S.items.find((i) => i.k === 'user');
    if (first && !S.title) S.title = userText(first.content).slice(0, 60);
    changed();
  } catch {}
}

function userText(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
}

async function resumeSession(sess) {
  const cwd = sess.cwd || store.project;
  if (cwd !== store.project) {
    S.cwd = cwd; // switch project without starting a blank chat
    setStore({ project: cwd });
  }
  try {
    const hist = await api('/api/chat/history?cwd=' + encodeURIComponent(cwd) + '&id=' + encodeURIComponent(sess.id));
    newChat({ resume: sess.id });
    loadHistory(hist);
    S.title = sess.title;
    changed();
  } catch (e) {
    toast('Could not open session: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers

function rel(p) {
  const cwd = (S.cwd || store.project || '').replace(/\/+$/, '');
  if (p && cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return p || '';
}

const PHONE = {
  read_screen: ['Read screen', 'phone'], screenshot: ['Screenshot', 'image'], tap: ['Tap', 'hand'], long_press: ['Long press', 'hand'],
  type: ['Type', 'keyboard'], scroll: ['Scroll', 'hand'], swipe: ['Swipe', 'hand'], press_key: ['Press', 'phone'],
  wait_for: ['Wait for', 'phone'], open_app: ['Open app', 'phone'], list_apps: ['Apps', 'list'], open_url: ['Open link', 'globe'],
  set_alarm: ['Alarm', 'phone'], set_timer: ['Timer', 'phone'], add_calendar_event: ['Calendar', 'list'], compose_message: ['Message', 'chat'],
  share_text: ['Share', 'ext'], open_settings: ['Settings', 'gear'], notifications: ['Notifications', 'list'], clipboard: ['Clipboard', 'copy'],
  phone_status: ['Phone', 'phone'], play_music: ['Play', 'play'], media: ['Media', 'volume'], start_intent: ['Open', 'ext'],
  back_to_skiff: ['Back to Skiff', 'phone'],
};
const phoneTool = (name) => (name.startsWith('mcp__phone__') ? name.slice(12) : null);
const pad2 = (n) => String(n).padStart(2, '0');

function phoneSummary(t, i) {
  switch (t) {
    case 'tap': case 'long_press': return i.text ? `"${i.text}"` : i.id != null ? '#' + i.id : i.x != null ? `${i.x}, ${i.y}` : '';
    case 'type': return `"${(i.text || '').slice(0, 60)}"` + (i.submit ? ' ⏎' : '');
    case 'scroll': return i.direction || '';
    case 'press_key': return i.key || '';
    case 'wait_for': return `"${i.text || ''}"`;
    case 'open_app': return i.name || '';
    case 'open_url': return i.url || '';
    case 'set_alarm': return `${pad2(i.hour || 0)}:${pad2(i.minute || 0)}` + (i.label ? ' · ' + i.label : '');
    case 'set_timer': { const s = +i.seconds || 0; return (s >= 60 ? Math.floor(s / 60) + ' min ' : '') + (s % 60 ? (s % 60) + ' s' : '') + (i.label ? ' · ' + i.label : ''); }
    case 'add_calendar_event': return (i.title || '') + (i.start ? ' · ' + i.start.replace('T', ' ') : '');
    case 'compose_message': return (i.kind || '') + (i.to ? ' to ' + i.to : '');
    case 'open_settings': return i.page || 'main';
    case 'clipboard': return i.text ? 'copy' : 'read';
    case 'play_music': return (i.query ? `"${i.query}"` : 'music') + (i.app && i.app !== 'youtube_music' ? ' · ' + i.app : '');
    case 'media': return (i.action || '').replace(/_/g, ' ') + (i.level != null ? ' ' + i.level + '%' : '');
    case 'start_intent': return i.data || (i.action || '').replace('android.intent.action.', '');
    default: return '';
  }
}

function toolSummary(name, input) {
  const pt = phoneTool(name);
  if (pt) return phoneSummary(pt, input || {});
  switch (name) {
    case 'Read': return rel(input.file_path) + (input.offset ? ` (from line ${input.offset})` : '');
    case 'Write': case 'Edit': case 'MultiEdit': return rel(input.file_path);
    case 'NotebookEdit': return rel(input.notebook_path);
    case 'Bash': return input.description || input.command;
    case 'BashOutput': return 'shell ' + (input.bash_id || '');
    case 'Glob': return input.pattern;
    case 'Grep': return `"${input.pattern}"` + (input.path ? ' in ' + rel(input.path) : '');
    case 'LS': return rel(input.path);
    case 'WebFetch': return input.url;
    case 'WebSearch': return input.query;
    case 'Task': case 'Agent': return input.description || input.subagent_type || '';
    case 'TodoWrite': return `${(input.todos || []).length} items`;
    case 'AskUserQuestion': return ((input.questions || [])[0] || {}).question || 'Question';
    case 'ExitPlanMode': return 'Plan ready';
    default: {
      const v = Object.values(input || {}).find((x) => typeof x === 'string' && x.trim());
      const s = v || (Object.keys(input || {}).length ? JSON.stringify(input) : '');
      return s.length > 90 ? s.slice(0, 90) + '…' : s;
    }
  }
}

function toolLabel(name) {
  const pt = phoneTool(name);
  if (pt) return (PHONE[pt] || [pt])[0];
  if (name.startsWith('mcp__')) return name.split('__').slice(1).join(' · ');
  return { Bash: 'Run', Read: 'Read', Write: 'Write', Edit: 'Edit', MultiEdit: 'Edit', Glob: 'Find files', Grep: 'Search', LS: 'List', WebFetch: 'Fetch', WebSearch: 'Web search', Task: 'Agent', Agent: 'Agent', TodoWrite: 'To-dos', ExitPlanMode: 'Plan', NotebookEdit: 'Notebook', AskUserQuestion: 'Question' }[name] || name;
}

function toolIcon(name) {
  const pt = phoneTool(name);
  if (pt) return (PHONE[pt] || [0, 'phone'])[1];
  return { Bash: 'terminal', Read: 'file', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', Glob: 'search', Grep: 'search', LS: 'folder', WebFetch: 'globe', WebSearch: 'globe', Task: 'branch', Agent: 'branch', TodoWrite: 'list', ExitPlanMode: 'list', AskUserQuestion: 'chat' }[name] || 'tool';
}

function Diff({ oldText = '', newText = '', path }) {
  const parts = diffLines(oldText, newText);
  const rows = [];
  for (const p of parts) {
    const lines = p.value.replace(/\n$/, '').split('\n');
    for (const l of lines) rows.push({ t: p.added ? 'add' : p.removed ? 'del' : 'ctx', l });
  }
  // collapse long unchanged runs
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.t === 'ctx') {
      let j = i;
      while (j < rows.length && rows[j].t === 'ctx') j++;
      const run = j - i;
      if (run > 6) {
        out.push(rows[i], rows[i + 1]);
        out.push({ t: 'gap', l: `⋯ ${run - 4} unchanged lines` });
        out.push(rows[j - 2], rows[j - 1]);
        i = j - 1;
        continue;
      }
    }
    out.push(r);
  }
  return html`<div class="diff">${path ? html`<div class="diff-path">${path}</div>` : null}
    ${out.map((r) => html`<div class=${'dl ' + r.t}><span class="dm">${r.t === 'add' ? '+' : r.t === 'del' ? '−' : ' '}</span>${r.l}</div>`)}
  </div>`;
}

function Todos({ todos = [] }) {
  return html`<ul class="todos">${todos.map((t) => html`<li class=${t.status}>
    <span class="tbox">${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : ''}</span>
    <span>${t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span></li>`)}</ul>`;
}

function ToolBody({ it }) {
  const { name, input, result } = it;
  const out = [];
  if (name === 'Edit') out.push(html`<${Diff} oldText=${input.old_string} newText=${input.new_string} />`);
  else if (name === 'MultiEdit') (input.edits || []).forEach((e) => out.push(html`<${Diff} oldText=${e.old_string} newText=${e.new_string} />`));
  else if (name === 'Write') out.push(html`<${Diff} oldText="" newText=${(input.content || '').split('\n').slice(0, 80).join('\n')} />`);
  else if (name === 'Bash') out.push(html`<pre class="cmd">$ ${input.command}</pre>`);
  else if (name === 'TodoWrite' || name === 'ExitPlanMode' || phoneTool(name)) {
  } else if (!['Read', 'Glob', 'Grep', 'LS'].includes(name)) out.push(html`<pre class="json">${JSON.stringify(input, null, 2)}</pre>`);
  if (result && result.images && result.images.length) out.push(html`<div class="shots">${result.images.map((src) => html`<img src=${src} alt="Screenshot" />`)}</div>`);
  if (it.children && it.children.length) out.push(html`<div class="subtools">${it.children.map((c) => html`<${ToolCard} it=${c} nested />`)}</div>`);
  if (result && result.text && !['Edit', 'MultiEdit', 'Write', 'TodoWrite'].includes(name)) {
    const t = result.text.length > 6000 ? result.text.slice(0, 6000) + '\n… (truncated)' : result.text;
    out.push(html`<pre class=${'result' + (result.isError ? ' err' : '')}>${t}</pre>`);
  } else if (result && result.isError) out.push(html`<pre class="result err">${result.text}</pre>`);
  return html`<div class="tool-body">${out}</div>`;
}

function ToolCard({ it, nested }) {
  const alwaysOpen = it.name === 'TodoWrite' || it.name === 'ExitPlanMode';
  const [open, setOpen] = useState(false);
  const state = !it.result ? 'run' : it.result.isError ? 'err' : 'ok';
  return html`<div class=${'tool ' + state + (nested ? ' nested' : '')}>
    <button class="tool-head" onClick=${() => setOpen(!open)}>
      <span class="tool-ico"><${Icon} name=${toolIcon(it.name)} size=${15} /></span>
      <span class="tool-name">${toolLabel(it.name)}</span>
      <span class="tool-sum">${toolSummary(it.name, it.input)}</span>
      <span class="tool-state">${state === 'run' ? html`<span class="spin" />` : state === 'err' ? html`<${Icon} name="alert" size=${14} />` : html`<${Icon} name="check" size=${14} />`}</span>
    </button>
    ${it.name === 'TodoWrite' ? html`<${Todos} todos=${it.input.todos} />` : null}
    ${it.name === 'ExitPlanMode' && it.input.plan ? html`<div class="plan"><${Markdown} text=${it.input.plan} /></div>` : null}
    ${open && !alwaysOpen ? html`<${ToolBody} it=${it} />` : null}
  </div>`;
}

function answerText(v) {
  return Array.isArray(v) ? v.join(', ') : String(v);
}

// AskUserQuestion: Claude's clarifying questions, answered with option
// buttons or free text. The answers go back as updatedInput.answers, keyed
// by question text, as Claude Code expects.
function QuestionCard({ it }) {
  const questions = (it.input && it.input.questions) || [];
  const [pick, setPick] = useState(() => questions.map((q) => (q.multiSelect ? [] : null)));
  const [other, setOther] = useState(() => questions.map(() => ''));
  const [otherOn, setOtherOn] = useState(() => questions.map(() => false));

  if (it.state !== 'pending') {
    const a = it.answers || {};
    return html`<div class="question done">
      ${it.state === 'denied' ? html`<div class="muted small">✕ Question skipped</div>`
        : questions.map((q) => html`<div class="qa"><div class="qa-q">${q.question}</div><div class="qa-a">${a[q.question] !== undefined ? answerText(a[q.question]) : '—'}</div></div>`)}
    </div>`;
  }

  const toggle = (qi, label) => {
    const q = questions[qi];
    const next = pick.slice();
    if (q.multiSelect) {
      const cur = new Set(next[qi]);
      cur.has(label) ? cur.delete(label) : cur.add(label);
      next[qi] = [...cur];
    } else {
      next[qi] = next[qi] === label ? null : label;
      const oo = otherOn.slice(); oo[qi] = false; setOtherOn(oo);
    }
    setPick(next);
  };
  const toggleOther = (qi) => {
    const oo = otherOn.slice();
    oo[qi] = !oo[qi];
    setOtherOn(oo);
    if (!questions[qi].multiSelect && oo[qi]) { const n = pick.slice(); n[qi] = null; setPick(n); }
  };
  const valueFor = (qi) => {
    const q = questions[qi];
    const custom = otherOn[qi] && other[qi].trim();
    if (q.multiSelect) {
      const v = [...(pick[qi] || [])];
      if (custom) v.push(custom);
      return v.length ? v : null;
    }
    return custom || pick[qi];
  };
  const complete = questions.every((_, i) => valueFor(i));
  const submit = () => {
    const answers = {};
    questions.forEach((q, i) => { answers[q.question] = valueFor(i); });
    send({ t: 'approve', id: it.id, allow: true, updatedInput: { ...it.input, answers } });
  };
  const skip = () => send({ t: 'approve', id: it.id, allow: false, message: 'The user skipped these questions. Ask again in plain text, or make a sensible choice and say which you made.' });

  return html`<div class="question">
    ${questions.map((q, qi) => html`<div class="q-block">
      <div class="q-head">${q.header ? html`<span class="q-chip">${q.header}</span>` : null}${q.multiSelect ? html`<span class="muted small">Choose any</span>` : null}</div>
      <div class="q-text">${q.question}</div>
      <div class="q-opts">
        ${(q.options || []).map((o) => {
          const on = q.multiSelect ? (pick[qi] || []).includes(o.label) : pick[qi] === o.label;
          return html`<button class=${'q-opt' + (on ? ' on' : '')} onClick=${() => toggle(qi, o.label)}>
            <span class=${'q-mark' + (q.multiSelect ? ' sq' : '')}>${on ? '✓' : ''}</span>
            <span class="q-body"><span class="q-label">${o.label}</span>${o.description ? html`<span class="q-desc">${o.description}</span>` : null}</span>
          </button>`;
        })}
        <button class=${'q-opt' + (otherOn[qi] ? ' on' : '')} onClick=${() => toggleOther(qi)}>
          <span class=${'q-mark' + (q.multiSelect ? ' sq' : '')}>${otherOn[qi] ? '✓' : ''}</span><span class="q-body"><span class="q-label">Other…</span></span>
        </button>
        ${otherOn[qi] ? html`<textarea class="input q-other" rows="2" placeholder="Type your answer" value=${other[qi]} onInput=${(e) => { const n = other.slice(); n[qi] = e.target.value; setOther(n); }} />` : null}
      </div>
    </div>`)}
    <div class="ap-actions">
      <button class="btn primary" disabled=${!complete} onClick=${submit}>${questions.length > 1 ? 'Submit answers' : 'Submit'}</button>
      <button class="btn ghost" onClick=${skip}>Skip</button>
    </div>
  </div>`;
}

function Approval({ it }) {
  if (it.tool === 'AskUserQuestion') return html`<${QuestionCard} it=${it} />`;
  const [denying, setDenying] = useState(false);
  const [msg, setMsg] = useState('');
  const { tool, input } = it;
  const answer = (allow, extra = {}) => send({ t: 'approve', id: it.id, allow, ...extra });
  if (it.state !== 'pending') {
    return html`<div class="approval done">${it.state === 'denied' ? '✕ Denied' : it.state === 'always' ? '✓ Allowed for this session' : '✓ Allowed'}: ${toolLabel(tool)} ${toolSummary(tool, input)}</div>`;
  }
  let preview = null;
  if (tool === 'Edit') preview = html`<${Diff} oldText=${input.old_string} newText=${input.new_string} path=${rel(input.file_path)} />`;
  else if (tool === 'MultiEdit') preview = (input.edits || []).map((e) => html`<${Diff} oldText=${e.old_string} newText=${e.new_string} />`);
  else if (tool === 'Write') preview = html`<${Diff} oldText="" newText=${(input.content || '').split('\n').slice(0, 60).join('\n')} path=${rel(input.file_path)} />`;
  else if (tool === 'Bash') preview = html`<pre class="cmd">$ ${input.command}</pre>`;
  else if (tool === 'ExitPlanMode') preview = html`<div class="plan"><${Markdown} text=${input.plan || ''} /></div>`;
  else preview = html`<pre class="json">${JSON.stringify(input, null, 2)}</pre>`;

  if (tool === 'ExitPlanMode') {
    const go = (mode) => {
      answer(true);
      setMode(mode);
    };
    return html`<div class="approval">
      <div class="ap-title"><${Icon} name="list" size=${16} /> Ready to code?</div>
      ${preview}
      <div class="ap-actions col">
        <button class="btn primary" onClick=${() => go('acceptEdits')}>Yes, and auto-accept edits</button>
        <button class="btn" onClick=${() => go('default')}>Yes, and ask before edits</button>
        <button class="btn ghost" onClick=${() => answer(false, { message: 'Keep planning. ' + msg })}>No, keep planning</button>
      </div></div>`;
  }
  return html`<div class="approval">
    <div class="ap-title"><${Icon} name="shield" size=${16} /> Allow ${toolLabel(tool).toLowerCase()}?</div>
    <div class="ap-sum">${toolSummary(tool, input)}</div>
    ${preview}
    ${denying ? html`<div class="ap-deny">
        <input class="input" placeholder="Tell Claude what to do instead (optional)" value=${msg} onInput=${(e) => setMsg(e.target.value)} />
        <div class="ap-actions"><button class="btn danger" onClick=${() => answer(false, { message: msg })}>Deny</button><button class="btn ghost" onClick=${() => setDenying(false)}>Back</button></div>
      </div>`
      : html`<div class="ap-actions">
        <button class="btn primary" onClick=${() => answer(true)}>Allow</button>
        <button class="btn" onClick=${() => answer(true, { always: true })}>Always allow ${toolLabel(tool)}</button>
        <button class="btn ghost" onClick=${() => setDenying(true)}>Deny</button>
      </div>`}
  </div>`;
}

function UserMsg({ content }) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content || [];
  return html`<div class="msg user">${blocks.map((b) =>
    b.type === 'image' ? html`<img class="att" src=${`data:${b.source.media_type};base64,${b.source.data}`} />` : html`<div class="utext">${b.text}</div>`)}</div>`;
}

function Thinking({ text, live }) {
  const [open, setOpen] = useState(false);
  return html`<div class="thinking">
    <button class="think-head" onClick=${() => setOpen(!open)}><${Icon} name="brain" size=${14} /> ${live ? 'Thinking…' : 'Thought process'} <${Icon} name=${open ? 'down' : 'right'} size=${14} /></button>
    ${open ? html`<div class="think-body">${text}</div>` : null}
  </div>`;
}

function Result({ data }) {
  const secs = data.duration_ms ? Math.round(data.duration_ms / 1000) : 0;
  const parts = [];
  if (data.num_turns) parts.push(`${data.num_turns} turn${data.num_turns > 1 ? 's' : ''}`);
  if (secs) parts.push(secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`);
  if (typeof data.total_cost_usd === 'number') parts.push(`$${data.total_cost_usd.toFixed(3)} of SDK credit`);
  if (data.is_error || (data.subtype && data.subtype !== 'success')) {
    return html`<div class="error-card"><${Icon} name="alert" size=${16} /> ${data.result || data.subtype || 'Error'}</div>`;
  }
  return html`<div class="result-line">${parts.join(' · ')}</div>`;
}

// ---------------------------------------------------------------------------
// Voice mode: talk, Claude works, the reply is read aloud, then it listens again.

const VM = { on: false, phase: 'idle', heard: '', reply: '', empties: 0, waitTurn: false, userIdx: 0 };

function vmStart() {
  bridge.call('audioFocus', true); // pause music while we talk
  stopSpeaking();
  Object.assign(VM, { on: true, empties: 0, reply: '', heard: '' });
  vmListen();
}

function vmListen() {
  if (!VM.on) return;
  VM.phase = 'listening';
  VM.heard = '';
  changed();
  startListening({
    vad: true,
    onPartial: (t) => { VM.heard = t; changed(); },
    onFinal: (t) => {
      if (!VM.on) return;
      t = (t || '').trim();
      if (!t) {
        VM.empties++;
        if (VM.empties >= 2) {
          VM.phase = 'paused';
          changed();
          // the assistant puts itself away after a quiet moment, like Gemini
          if (ASSIST) setTimeout(() => { if (VM.on && VM.phase === 'paused') bridge.call('minimize'); }, 6000);
          return;
        }
        return vmListen();
      }
      VM.empties = 0;
      VM.heard = t;
      VM.phase = 'thinking';
      VM.userIdx = S.items.length;
      VM.waitTurn = true;
      if (!S.title) S.title = t.slice(0, 60);
      changed();
      send({ t: 'send', content: [{ type: 'text', text: t }] });
    },
  });
}

function vmOnResult() {
  VM.waitTurn = false;
  if (!VM.on) return;
  const reply = S.items.slice(VM.userIdx).filter((i) => i.k === 'text').map((i) => i.text).join('\n\n') || 'Done.';
  VM.reply = reply;
  if (!V.speakReplies) return vmListen();
  VM.phase = 'speaking';
  changed();
  speak(speakable(reply), () => { if (VM.on && VM.phase === 'speaking') vmListen(); });
}

// ---- side-button assistant ----
function startAssist() {
  if (Date.now() - lastActive() > FRESH_AFTER && S.items.length && !S.busy) newChat();
  if (!VM.on) vmStart();
  else if (VM.phase !== 'thinking') { stopSpeaking(); vmListen(); }
}
if (ASSIST) {
  window.addEventListener('skiff-assist', startAssist);
  window.addEventListener('skiff-assist-hide', () => vmStop());
  setTimeout(startAssist, 250); // a fresh page: start listening straight away
}

function vmStop() {
  bridge.call('audioFocus', false);
  VM.on = false;
  VM.phase = 'idle';
  cancelListening();
  stopSpeaking();
  changed();
}

function VoicePanel() {
  const [, force] = useState(0);
  useEffect(() => onVoice(() => force((n) => n + 1)), []);
  useEffect(() => pushBack(vmStop), []);
  const tapOrb = () => {
    if (VM.phase === 'speaking') { stopSpeaking(); vmListen(); }
    else if (VM.phase === 'listening') stopListening();
    else if (VM.phase === 'paused' || VM.phase === 'input') { VM.empties = 0; vmListen(); }
  };
  const label = {
    listening: V.busy ? 'Transcribing…' : 'Listening… tap when you\'re done',
    thinking: 'Claude is working…',
    speaking: 'Speaking. Tap to interrupt',
    paused: 'Paused. Tap to talk',
    input: 'Answer Claude above, then tap to talk',
  }[VM.phase] || '';
  const scale = VM.phase === 'listening' ? 1 + V.level * 0.06 : 1;
  const text = VM.phase === 'speaking' ? speakable(VM.reply).slice(0, 220) : VM.heard;
  return html`<div class="voice-panel">
    <div class="vp-label">${label}</div>
    ${text ? html`<div class="vp-text">${text}</div>` : null}
    <div class="vp-row">
      <button class="icon-btn" title=${V.speakReplies ? 'Mute replies' : 'Read replies aloud'} onClick=${() => setVoicePref('speakReplies', !V.speakReplies)}><${Icon} name=${V.speakReplies ? 'volume' : 'mute'} /></button>
      <button class=${'orb ' + VM.phase} onClick=${tapOrb} style=${`transform:scale(${scale})`}>
        ${VM.phase === 'thinking' ? html`<span class="spin big" />` : html`<${Icon} name=${VM.phase === 'speaking' ? 'volume' : VM.phase === 'listening' ? 'up' : 'mic'} size=${30} />`}
      </button>
      ${ASSIST ? html`<button class="icon-btn" title="Type instead" onClick=${vmStop}><${Icon} name="keyboard" /></button>`
        : html`<button class="btn small" onClick=${vmStop}>End</button>`}
    </div>
    <div class="muted small vp-engine">${V.engine === 'whisper' ? 'Whisper (on-device)' : V.engine === 'device' ? 'On-device speech' : 'Phone speech'}${V.lang ? ' · ' + V.lang : ''}</div>
  </div>`;
}

function CtxMeter() {
  if (!S.ctx || !S.ctx.used) return null;
  const pct = Math.min(100, Math.round((S.ctx.used / (S.ctx.window || 200000)) * 100));
  const tip = `${S.ctx.used.toLocaleString()} of ${(S.ctx.window || 200000).toLocaleString()} tokens of context used. Claude compacts automatically, or send /compact.`;
  return html`<button class=${'ctx-meter' + (pct > 80 ? ' hot' : '')} title=${tip} onClick=${() => toast(tip, 4500)} style=${`--p:${pct}`}><span>${pct}%</span></button>`;
}

// ---------------------------------------------------------------------------
// Composer

async function fileToImageBlock(file) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = URL.createObjectURL(file);
  });
  const max = 1568;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const data = c.toDataURL('image/jpeg', 0.85).split(',')[1];
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } };
}

function setMode(mode) {
  S.mode = mode;
  localStorage.setItem('skiff.mode', mode);
  send({ t: 'config', mode });
  changed();
}

function PlusMenu({ onClose, onImage, onMention, onSlash }) {
  useEffect(() => pushBack(onClose), []);
  const go = (f) => () => { onClose(); f(); };
  return html`<div class="menu-backdrop" onClick=${onClose}><div class="menu up" onClick=${(e) => e.stopPropagation()}>
    <button class="menu-item row-i" onClick=${go(() => openLibrary())}><${Icon} name="spark" class="grad" /><div><div class="mi-title">Things I can do</div><div class="mi-hint">${TEMPLATES.length} ready-made tasks: WhatsApp, music, alarms, code…</div></div></button>
    <button class="menu-item row-i" onClick=${go(onImage)}><${Icon} name="image" /><div><div class="mi-title">Photo or screenshot</div><div class="mi-hint">Attach images for Claude to look at</div></div></button>
    <button class="menu-item row-i" onClick=${go(onMention)}><${Icon} name="at" /><div><div class="mi-title">Mention a file</div><div class="mi-hint">Point Claude at a file in this project</div></div></button>
    <button class="menu-item row-i" onClick=${go(onSlash)}><${Icon} name="list" /><div><div class="mi-title">Slash command</div><div class="mi-hint">/compact, /init, /review and more</div></div></button>
    <button class="menu-item row-i" onClick=${go(vmStart)}><${Icon} name="wave" /><div><div class="mi-title">Voice mode</div><div class="mi-hint">Talk to Claude and hear the replies</div></div></button>
  </div></div>`;
}

function ModeMenu({ onClose }) {
  useEffect(() => pushBack(onClose), []);
  return html`<div class="menu-backdrop" onClick=${onClose}><div class="menu up" onClick=${(e) => e.stopPropagation()}>
    <div class="menu-title">Permission mode</div>
    ${MODES.map((m) => html`<button class=${'opt' + (S.mode === m.id ? ' on' : '')} onClick=${() => { setMode(m.id); onClose(); }}>
      <span class="opt-text"><span class="opt-label">${m.label}</span><span class="opt-hint">${m.hint}</span></span>
      <span class="opt-check">${S.mode === m.id ? html`<${Icon} name="check" size=${16} />` : null}</span></button>`)}
    <div class="menu-sep" />
    <div class="menu-title">Model</div>
    <div class="opt-chips">${MODELS.map((m) => html`<button class=${'chip' + (S.model === m.id ? ' on' : '')} onClick=${() => {
      S.model = m.id; localStorage.setItem('skiff.model', m.id); send({ t: 'config', model: m.id }); onClose(); changed();
    }}>${m.id ? m.label : 'Default'}</button>`)}</div>
  </div></div>`;
}

function Composer() {
  const [text, setText] = useState(localStorage.getItem('skiff.draft') || '');
  useEffect(() => {
    composerSet = (t) => { setText(t); setTimeout(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(t.length, t.length); } }, 50); };
    return () => { composerSet = null; };
  }, []);
  const [atts, setAtts] = useState([]);
  const [mention, setMention] = useState(null); // { q, items }
  const [slash, setSlash] = useState(null);
  const [, forceV] = useState(0);
  useEffect(() => onVoice(() => forceV((n) => n + 1)), []);
  const [modeOpen, setModeOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const ta = useRef();
  const fileIn = useRef();

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + 'px';
    localStorage.setItem('skiff.draft', text);
  }, [text]);

  const onInput = async (e) => {
    const v = e.target.value;
    setText(v);
    const sm = v.match(/^\/([\w:-]*)$/);
    if (sm) {
      const list = (S.slash || DEFAULT_SLASH).filter((c) => c.toLowerCase().includes(sm[1].toLowerCase())).slice(0, 12);
      setSlash(list.length ? list : null);
    } else setSlash(null);
    const upto = v.slice(0, e.target.selectionStart);
    const m = upto.match(/(?:^|\s)@([\w./-]*)$/);
    if (m) {
      const q = m[1];
      try {
        const items = await api('/api/fs/find?root=' + encodeURIComponent(S.cwd || store.project) + '&q=' + encodeURIComponent(q));
        setMention({ q, items: items.slice(0, 8) });
      } catch { setMention(null); }
    } else setMention(null);
  };

  const pickMention = (p) => {
    const el = ta.current;
    const pos = el.selectionStart;
    const before = text.slice(0, pos).replace(/@([\w./-]*)$/, '@' + p + ' ');
    const v = before + text.slice(pos);
    setText(v);
    setMention(null);
    setTimeout(() => { el.focus(); el.selectionStart = el.selectionEnd = before.length; }, 0);
  };

  const dictate = () => {
    if (V.listening) { stopListening(); return; }
    const base = text;
    const join = (t) => (base && t ? base.replace(/\s*$/, ' ') : base) + t;
    startListening({ vad: false, onPartial: (t) => setText(join(t)), onFinal: (t) => { if (t) setText(join(t)); } });
  };

  const submit = () => {
    const t = text.trim();
    if (!t && !atts.length) return;
    const content = [];
    if (t) content.push({ type: 'text', text: t });
    content.push(...atts);
    if (!S.title && t) S.title = t.slice(0, 60);
    send({ t: 'send', content });
    setText('');
    setAtts([]);
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
  };

  const addFiles = async (files) => {
    const blocks = [];
    for (const f of files) {
      if (!f.type.startsWith('image/')) { toast('Only images can be attached'); continue; }
      try { blocks.push(await fileToImageBlock(f)); } catch { toast('Could not read image'); }
    }
    setAtts((a) => [...a, ...blocks]);
  };

  const mode = MODES.find((m) => m.id === S.mode) || MODES[0];
  return html`<div class="composer">
    ${slash ? html`<div class="mention">${slash.map((c) => html`<button class="mention-item" onClick=${() => { setText('/' + c + ' '); setSlash(null); ta.current.focus(); }}>/${c}</button>`)}</div>` : null}
    ${mention && mention.items.length ? html`<div class="mention">${mention.items.map((p) => html`<button class="mention-item" onClick=${() => pickMention(p)}><${Icon} name="file" size=${14} /> ${p}</button>`)}</div>` : null}
    ${atts.length ? html`<div class="atts">${atts.map((a, i) => html`<div class="att-th"><img src=${'data:image/jpeg;base64,' + a.source.data} /><button onClick=${() => setAtts(atts.filter((_, j) => j !== i))}>×</button></div>`)}</div>` : null}
    <div class="comp-box">
      <textarea ref=${ta} rows="1" placeholder=${S.busy ? 'Add a follow-up…' : 'Message Claude…'} value=${text} onInput=${onInput} onKeyDown=${onKey} autocapitalize="sentences" />
      <div class="comp-row">
        <button class="icon-btn plus" title="Add" onClick=${() => setPlusOpen(true)}><${Icon} name="plus" /></button>
        <button class=${'mode-chip m-' + mode.id} onClick=${() => setModeOpen(true)}>${mode.short}${S.model ? ' · ' + S.model : ''} <${Icon} name="down" size=${12} /></button>
        <${CtxMeter} />
        <div class="grow" />
        <button class=${'icon-btn' + (V.listening ? ' rec' : '')} title="Dictate" onClick=${dictate}>${V.busy ? html`<span class="spin" />` : html`<${Icon} name="mic" />`}</button>
        <input ref=${fileIn} type="file" accept="image/*" multiple hidden onChange=${(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
        ${S.busy && !text.trim() && !atts.length ? html`<button class="send stop" onClick=${() => send({ t: 'interrupt' })} title="Stop"><${Icon} name="stop" /></button>`
          : text.trim() || atts.length ? html`<button class="send" onClick=${submit} title="Send"><${Icon} name="up" /></button>`
          : html`<button class="send voice" onClick=${vmStart} title="Voice mode"><${Icon} name="wave" /></button>`}
      </div>
    </div>
    ${plusOpen ? html`<${PlusMenu} onClose=${() => setPlusOpen(false)}
      onImage=${() => fileIn.current.click()}
      onMention=${() => { setText(text + (text && !text.endsWith(' ') ? ' @' : '@')); setTimeout(() => ta.current.focus(), 0); }}
      onSlash=${() => { setText('/'); setSlash((S.slash || DEFAULT_SLASH).slice(0, 12)); setTimeout(() => ta.current.focus(), 0); }} />` : null}
    ${modeOpen ? html`<${ModeMenu} onClose=${() => setModeOpen(false)} />` : null}
  </div>`;
}

// ---------------------------------------------------------------------------

function SessionsSheet({ onClose }) {
  const [scope, setScope] = useState('project');
  const [list, setList] = useState(null);
  useEffect(() => pushBack(onClose), []);
  useEffect(() => {
    setList(null);
    const q = scope === 'all' ? 'all=1' : 'cwd=' + encodeURIComponent(store.project);
    api('/api/chat/sessions?' + q).then(setList).catch(() => setList([]));
  }, [scope]);
  return html`<div class="sheet-backdrop" onClick=${onClose}><div class="sheet tall" onClick=${(e) => e.stopPropagation()}>
    <div class="sheet-head"><b>Conversations</b><div class="grow" /><button class="icon-btn" onClick=${onClose}><${Icon} name="x" /></button></div>
    <div class="seg">
      <button class=${scope === 'project' ? 'on' : ''} onClick=${() => setScope('project')}>${basename(store.project)}</button>
      <button class=${scope === 'all' ? 'on' : ''} onClick=${() => setScope('all')}>All projects</button>
    </div>
    <div class="sheet-body">
      ${list === null ? html`<div class="muted pad row gap"><span class="spin" /> Loading…</div>`
        : !list.length ? html`<div class="muted pad">${scope === 'all' ? 'No conversations yet.' : 'No conversations in this project yet. Try All projects.'}</div>`
        : list.map((x) => html`<button class=${'row-btn conv' + (x.id === S.sessionId ? ' on' : '')} onClick=${() => { onClose(); resumeSession(x); }}>
          <div class="rb-title">${x.title || 'Untitled conversation'}</div>
          <div class="rb-sub">${relTime(x.mtime)}${scope === 'all' && x.cwd ? ' · ' + basename(x.cwd) : ''}</div></button>`)}
    </div></div></div>`;
}

export function ChatView() {
  const st = useStore();
  const [, force] = useState(0);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const scroller = useRef();
  const stick = useRef(true);

  useEffect(() => {
    const f = () => force((n) => n + 1);
    listeners.add(f);
    if (!S.ws) { S.cwd = store.project; connect(); }
    return () => listeners.delete(f);
  }, []);

  useEffect(() => {
    if (S.cwd && st.project && st.project !== S.cwd) newChat();
  }, [st.project]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const [away, setAway] = useState(false);
  const onScroll = (e) => {
    const el = e.target;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (away === stick.current) setAway(!stick.current);
  };
  const toBottom = () => { const el = scroller.current; if (el) { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); stick.current = true; setAway(false); } };

  const ready = st.status && st.status.ready && st.status.claude;
  const phone = !!(st.status && st.status.phone);
  const phoneOn = phone && !S.items.length && bridge.call('phoneControlOn');
  const phoneSugs = MINI && phone;
  const liveBlocks = S.live ? Object.values(S.live.blocks) : [];
  return html`<div class="view chat">
    ${MINI ? html`<button class="grabber" aria-label="Minimize" onClick=${() => bridge.call('minimize')}><span /></button>` : null}
    <div class=${'subbar' + (MINI ? ' mini-bar' : '')}>
      ${MINI ? html`<span class="mini-mark">✳</span>` : null}
      <button class="proj" onClick=${openProjectPicker}><${Icon} name="folder" size=${15} /> ${basename(st.project)} <${Icon} name="down" size=${12} /></button>
      <div class="sub-title">${S.title || (S.sessionId ? 'Conversation' : MINI ? '' : 'New conversation')}</div>
      <span class=${'dot ' + (S.connected ? (S.busy ? 'busy' : 'ok') : 'off')} />
      <button class="icon-btn" title="Past conversations" onClick=${() => setSessionsOpen(true)}><${Icon} name="history" /></button>
      <button class="icon-btn" title="New conversation" onClick=${() => newChat()}><${Icon} name="plus" /></button>
      ${MINI ? html`<button class="icon-btn" title="Open Skiff" onClick=${() => bridge.call('openApp')}><${Icon} name="expand" size=${19} /></button>
        <button class="icon-btn" title=${ASSIST ? 'Close' : 'Minimize'} onClick=${() => bridge.call('minimize')}><${Icon} name=${ASSIST ? 'x' : 'minimize'} /></button>` : null}
    </div>
    <div class="msgs" ref=${scroller} onScroll=${onScroll}>
      ${!S.items.length ? html`<div class="empty">
          <div class="empty-mark">✳</div>
          <h2>${MINI ? 'What can I do for you?' : 'What should we build?'}</h2>
          ${phone && !phoneOn ? html`<p class="muted small">Turn on <a href="#" onClick=${(e) => { e.preventDefault(); MINI ? bridge.call('openApp') : setStore({ tab: 'more' }); }}>phone control</a> in Setup so Claude can use your apps.</p>` : null}
          ${MINI ? null : html`<button class="proj-line" onClick=${() => openProjectPicker('folders')}><${Icon} name="folder" size=${14} /> ${st.project} <${Icon} name="down" size=${12} /></button>`}
          ${!ready ? html`<p class="warn small">Finish <a href="#" onClick=${(e) => { e.preventDefault(); MINI ? bridge.call('openApp') : setStore({ tab: 'more' }); }}>Setup</a>, then sign in once from Terminal → Claude Code (<code>/login</code>).</p>` : null}
          <div class="sugs">${(phoneSugs ? PHONE_SUGS : CODE_SUGS).map(byId).map((t) =>
            html`<button class="chip" onClick=${() => runTemplate(t.prompt, t.title)}><span class="ce"><${Icon} name=${t.icon} size=${15} /></span>${t.title}</button>`)}</div>
          <button class="btn lib-open" onClick=${() => openLibrary()}><${Icon} name="spark" size=${16} /> Browse ${TEMPLATES.length} things I can do</button>
          <div class="row gap center" style="margin-top:14px">
            ${MINI ? null : html`<button class="btn small ghost" onClick=${() => openProjectPicker('github')}><${Icon} name="branch" size=${14} /> Clone from GitHub</button>`}
            <button class="btn small ghost" onClick=${() => setSessionsOpen(true)}><${Icon} name="history" size=${14} /> Past conversations</button>
          </div>
          <p class="muted tiny">Chat uses your plan's Agent SDK credit · Terminal → Claude uses normal plan limits</p>
        </div>` : null}
      ${S.items.map((it, i) => {
        switch (it.k) {
          case 'user': return html`<${UserMsg} key=${i} content=${it.content} />`;
          case 'text': return html`<div class="msg asst" key=${i}><${Markdown} text=${it.text} /></div>`;
          case 'thinking': return html`<${Thinking} key=${i} text=${it.text} />`;
          case 'tool': return html`<${ToolCard} key=${it.id} it=${it} />`;
          case 'approval': return html`<${Approval} key=${'a' + it.id} it=${it} />`;
          case 'result': return html`<${Result} key=${i} data=${it.data} />`;
          case 'system': return html`<div class="sys" key=${i}>${it.text}</div>`;
          case 'error': return html`<div class="error-card" key=${i}><${Icon} name="alert" size=${16} /> <div class="grow"><div>${it.message}</div>${it.detail ? html`<details><summary>Details</summary><pre>${it.detail}</pre></details>` : null}</div></div>`;
        }
        return null;
      })}
      ${liveBlocks.map((b) => b.type === 'text' ? html`<div class="msg asst live"><${Markdown} text=${b.text} /></div>`
        : b.type === 'thinking' ? html`<${Thinking} text=${b.text} live />`
        : b.type === 'tool_use' ? html`<div class="tool run"><div class="tool-head"><span class="tool-ico"><${Icon} name=${toolIcon(b.name)} size=${15} /></span><span class="tool-name">${toolLabel(b.name || '')}</span><span class="tool-sum">preparing…</span><span class="spin" /></div></div>` : null)}
      ${S.busy && !liveBlocks.length ? html`<div class="working"><span class="spin" /> Working…</div>` : null}
    </div>
    ${away && S.items.length ? html`<button class="jump" onClick=${toBottom}><${Icon} name="down" size=${18} /></button>` : null}
    ${VM.on ? html`<${VoicePanel} />` : html`<${Composer} />`}
    ${sessionsOpen ? html`<${SessionsSheet} onClose=${() => setSessionsOpen(false)} />` : null}
  </div>`;
}

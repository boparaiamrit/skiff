// The side-button assistant: one card, one button, voice first.
// A separate small bundle (assist.html) so it opens instantly.
//
// Turn: listening → thinking → (working on the phone: a small pill only)
//       → speaking the answer → one short follow-up listen → closes.
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import './assist.css';
import { html, api, wsURL, bridge, uid, pushBack } from './core.js';
import { Icon } from './icons.js';
import { Markdown } from './md.js';
import { V, onVoice, startListening, stopListening, cancelListening, speak, stopSpeaking, speakable } from './voice.js';

const FRESH_AFTER = 10 * 60 * 1000; // a new conversation after 10 quiet minutes
const FOLLOWUP_CLOSE_MS = 1200; // after the follow-up listen hears nothing
const IDLE_CLOSE_MS = 9000; // nothing happening at all

// ---------------------------------------------------------------- state
const A = {
  phase: 'listening', // listening | thinking | working | speaking | answer | idle | error
  partial: '', heard: '', answer: '', live: '', step: '', error: '', errorAction: null,
  followup: false, byVoice: true, typing: false, acted: false,
  busy: false, connected: false, replaying: false,
  ask: null, // pending question or approval: { id, tool, input, qi, answers }
  pending: new Map(),
};
const subs = new Set();
let raf = 0;
let lastPhase = '', phaseAt = 0;
function changed() {
  if (A.phase !== lastPhase) { lastPhase = A.phase; phaseAt = Date.now(); }
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; subs.forEach((f) => f()); });
}

let chatId = localStorage.getItem('skiff.assistChat');
const lastActive = () => +localStorage.getItem('skiff.assistLast') || 0;
const touch = () => localStorage.setItem('skiff.assistLast', String(Date.now()));
function freshIfStale() {
  if (!chatId || Date.now() - lastActive() > FRESH_AFTER) {
    chatId = uid();
    localStorage.setItem('skiff.assistChat', chatId);
    touch();
    return true;
  }
  return false;
}
freshIfStale();

// ---------------------------------------------------------------- connection
let ws = null;
let queue = [];
let cwdP = null;
const projectsRoot = () => (cwdP = cwdP || api('/api/status').then((s) => s.projects).catch(() => ''));

function connect() {
  if (ws) { ws.onclose = null; ws.close(); }
  const sock = new WebSocket(wsURL('/api/chat/ws?id=' + encodeURIComponent(chatId)));
  ws = sock;
  sock.onopen = async () => {
    const cwd = await projectsRoot();
    if (ws !== sock) return;
    A.connected = true;
    sock.send(JSON.stringify({ t: 'config', cwd, mode: localStorage.getItem('skiff.mode') || 'default', model: localStorage.getItem('skiff.model') || '', assist: true }));
    sock.send(JSON.stringify({ t: 'warm' })); // start Claude while you talk
    const q = queue; queue = [];
    q.forEach((m) => sock.send(JSON.stringify(m)));
    changed();
  };
  sock.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch (e) { console.warn(e); } };
  sock.onclose = () => {
    if (ws !== sock) return;
    A.connected = false;
    changed();
    setTimeout(() => ws === sock && connect(), 1000);
  };
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  else queue.push(msg);
}

// ---------------------------------------------------------------- events from Claude
function handle(msg) {
  switch (msg.t) {
    case 'replay_start': A.replaying = true; A.pending.clear(); break;
    case 'replay_end':
      A.replaying = false;
      if (A.pending.size) showAsk([...A.pending.values()].pop());
      else if (A.busy && (A.phase === 'listening' || A.phase === 'idle')) { cancelListening(); A.phase = 'thinking'; }
      break;
    case 'status': A.busy = !!msg.busy; break;
    case 'approval': {
      const it = { id: msg.id, tool: msg.tool, input: msg.input || {}, qi: 0, answers: {} };
      A.pending.set(msg.id, it);
      if (!A.replaying) showAsk(it);
      break;
    }
    case 'approval_done':
      A.pending.delete(msg.id);
      if (A.ask && A.ask.id === msg.id) { A.ask = null; if (!A.replaying) A.phase = 'thinking'; }
      break;
    case 'ev': if (!A.replaying) onEvent(msg.ev); break;
    case 'error': if (!A.replaying) fail(msg.message || 'Something went wrong.'); break;
    case 'exit': if (!A.replaying && !msg.expected && msg.wasBusy) fail('Claude stopped unexpectedly. Try again.'); break;
    case 'interrupted': if (!A.replaying) { A.phase = 'idle'; A.step = ''; } break;
  }
  changed();
}

function onEvent(ev) {
  if (!ev || ev.parent_tool_use_id) return; // sub-agents: keep it simple
  if (ev.type === 'stream_event') {
    const e = ev.event || {};
    if (e.type === 'message_start') A.live = '';
    if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && A.phase === 'thinking') {
      A.live += e.delta.text;
      A.answer = A.live;
    }
    return;
  }
  if (ev.type === 'assistant') {
    for (const b of (ev.message && ev.message.content) || []) {
      if (b.type === 'tool_use' && b.name !== 'AskUserQuestion') {
        A.step = stepLabel(b.name, b.input || {});
        A.answer = '';
        A.live = '';
        // once Claude has started using the phone, stay small until the turn ends
        if (isScreenAction(b.name)) A.acted = true;
        A.phase = A.acted ? 'working' : 'thinking';
      }
    }
    return;
  }
  if (ev.type === 'result') {
    const text = typeof ev.result === 'string' && ev.result.trim() ? ev.result.trim() : A.answer || 'Done.';
    if (ev.is_error) return fail(text);
    finishTurn(text);
  }
}

function fail(message) {
  cancelListening();
  A.phase = 'error';
  A.error = message;
  A.errorAction = null;
  A.step = '';
  scheduleClose(IDLE_CLOSE_MS * 2);
}

// ---------------------------------------------------------------- the turn
function listen() {
  if (A.typing) return;
  cancelClose();
  stopSpeaking();
  A.phase = 'listening';
  A.partial = '';
  A.error = '';
  bridge.call('haptic');
  changed();
  startListening({
    vad: true,
    onPartial: (t) => { A.partial = t; changed(); },
    onFinal: (t, reason) => heard((t || '').trim(), reason),
  });
}

function heard(text, reason) {
  if (A.phase !== 'listening') return;
  if (text) {
    if (A.ask) return answerAskByVoice(text);
    return ask(text, true);
  }
  if (reason && reason !== 'silence') {
    voiceError(reason);
  } else if (A.followup || A.ask) {
    // nothing more to say: leave the answer on screen a moment, then go
    A.phase = A.ask ? 'idle' : 'answer';
    scheduleClose(A.ask ? IDLE_CLOSE_MS : FOLLOWUP_CLOSE_MS);
  } else {
    A.phase = 'idle';
    scheduleClose(IDLE_CLOSE_MS);
  }
  changed();
}

function ask(text, byVoice) {
  cancelClose();
  if (Date.now() - lastActive() > FRESH_AFTER && !A.busy && freshIfStale()) connect();
  touch();
  Object.assign(A, { heard: text, partial: '', answer: '', live: '', step: '', error: '', followup: false, byVoice, acted: false, phase: 'thinking' });
  send({ t: 'send', content: [{ type: 'text', text }] });
  changed();
}

function finishTurn(text) {
  touch();
  A.acted = false;
  A.answer = text;
  A.step = '';
  A.live = '';
  if (A.byVoice && V.speakReplies) {
    A.phase = 'speaking';
    changed();
    speak(speakable(text), () => {
      if (A.phase !== 'speaking') return; // interrupted
      A.followup = true;
      listen();
    });
  } else {
    A.phase = 'answer';
    scheduleClose(IDLE_CLOSE_MS * 2);
    changed();
  }
}

function interrupt() {
  send({ t: 'interrupt' });
  A.phase = 'idle';
  A.step = '';
  A.answer = A.answer || 'Stopped.';
  changed();
}

function voiceError(reason) {
  const r = String(reason);
  A.phase = 'error';
  A.errorAction = null;
  if (r === 'permission') {
    A.error = 'Skiff needs the microphone.';
    A.errorAction = ['Allow', () => bridge.call('requestMic')];
  } else if (r === 'unavailable') {
    A.error = 'No speech recognition on this phone. Type instead, or choose Whisper in Setup → Voice.';
  } else if (r === '2' || r === '4') {
    A.error = 'Speech recognition needs internet. Try again, or switch to on-device speech in Setup → Voice.';
  } else if (r === '12' || r === '13') {
    A.error = 'This language isn\'t available for speech yet. Pick another in Setup → Voice.';
  } else {
    A.error = 'I couldn\'t hear that.';
  }
  scheduleClose(IDLE_CLOSE_MS * 2);
}

// ---- questions and approvals: big buttons, or just say it
function showAsk(it) {
  cancelListening();
  cancelClose();
  A.ask = it;
  A.phase = 'idle';
  const say = askPrompt(it);
  if (A.byVoice && V.speakReplies) {
    A.phase = 'speaking';
    speak(say, () => { if (A.ask === it && A.phase === 'speaking') listen(); });
  }
  changed();
}

function askPrompt(it) {
  if (it.tool === 'AskUserQuestion') {
    const q = (it.input.questions || [])[it.qi];
    return q ? q.question : 'I have a question.';
  }
  return approvalQuestion(it.tool, it.input);
}

function approvalQuestion(tool, i) {
  const base = (p) => String(p || '').split('/').filter(Boolean).pop() || 'a file';
  switch (tool) {
    case 'Bash': return `Can I run a command${i.description ? ': ' + i.description.replace(/\.$/, '').toLowerCase() : ''}?`;
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return `Can I change ${base(i.file_path || i.notebook_path)}?`;
    case 'WebFetch': { let h = ''; try { h = new URL(i.url).hostname; } catch {} return `Can I open ${h || 'this web page'}?`; }
    case 'WebSearch': return 'Can I search the web?';
    case 'ExitPlanMode': return 'Shall I go ahead with this plan?';
    default: return `Can I use ${tool.replace(/^mcp__/, '').replace(/__/g, ' ')}?`;
  }
}

function answerAskByVoice(text) {
  const it = A.ask;
  const t = text.toLowerCase();
  if (it.tool !== 'AskUserQuestion') {
    if (/\b(no|don'?t|deny|stop|cancel|nahi|nahin|mat)\b/.test(t)) return decide(false);
    if (/\b(yes|yeah|yep|ok|okay|sure|go|allow|do it|haan|ha|theek|kar do)\b/.test(t)) return decide(true);
    A.phase = 'idle';
    changed();
    return;
  }
  const q = (it.input.questions || [])[it.qi];
  const opt = (q.options || []).find((o) => t.includes(o.label.toLowerCase())) ||
    (q.options || []).find((o) => o.label.toLowerCase().split(/\s+/).some((w) => w.length > 3 && t.includes(w)));
  pickAnswer(opt ? opt.label : text);
}

function pickAnswer(label) {
  const it = A.ask;
  const qs = it.input.questions || [];
  const q = qs[it.qi];
  it.answers[q.question] = q.multiSelect ? [label] : label;
  if (it.qi + 1 < qs.length) {
    it.qi++;
    showAsk(it);
    return;
  }
  send({ t: 'approve', id: it.id, allow: true, updatedInput: { ...it.input, answers: it.answers } });
  A.ask = null;
  A.phase = 'thinking';
  A.step = '';
  changed();
}

function decide(allow) {
  const it = A.ask;
  send({ t: 'approve', id: it.id, allow, ...(allow ? {} : { message: 'The user said no.' }) });
  A.ask = null;
  A.phase = 'thinking';
  changed();
}

// ---------------------------------------------------------------- closing
let closeTimer = 0;
function scheduleClose(ms) {
  cancelClose();
  closeTimer = setTimeout(close, ms);
}
function cancelClose() { clearTimeout(closeTimer); closeTimer = 0; }
function close() {
  cancelClose();
  cancelListening();
  stopSpeaking();
  bridge.call('audioFocus', false);
  A.typing = false;
  bridge.call('minimize');
}

function openInApp() {
  // show this conversation in the full app
  localStorage.setItem('skiff.chat', chatId);
  projectsRoot().then((p) => { if (p) localStorage.setItem('skiff.project', p); bridge.call('openApp'); });
}

// ---------------------------------------------------------------- labels
const LOOK = new Set(['read_screen', 'wait_for', 'list_apps', 'notifications', 'clipboard', 'phone_status', 'media', 'unlock']);
const pad2 = (n) => String(n).padStart(2, '0');
function isScreenAction(name) {
  return name.startsWith('mcp__phone__') && !LOOK.has(name.slice(12));
}
function stepLabel(name, i) {
  if (name.startsWith('mcp__phone__')) {
    const t = name.slice(12);
    switch (t) {
      case 'read_screen': return 'Looking at the screen…';
      case 'screenshot': return 'Taking a screenshot…';
      case 'tap': return i.text ? `Tapping "${i.text}"…` : 'Tapping…';
      case 'long_press': return 'Pressing…';
      case 'type': return 'Typing…';
      case 'scroll': case 'swipe': return 'Scrolling…';
      case 'press_key': return i.key === 'back' ? 'Going back…' : i.key === 'home' ? 'Going home…' : 'Pressing a key…';
      case 'wait_for': return 'Waiting for the screen…';
      case 'open_app': return `Opening ${i.name || 'the app'}…`;
      case 'list_apps': return 'Checking your apps…';
      case 'open_url': case 'start_intent': return 'Opening…';
      case 'play_music': return i.query ? `Playing ${i.query}…` : 'Playing music…';
      case 'media': return { pause: 'Pausing…', play: 'Playing…', next: 'Skipping…', previous: 'Going back a song…' }[i.action] || 'Adjusting the volume…';
      case 'set_alarm': return `Setting an alarm for ${pad2(i.hour || 0)}:${pad2(i.minute || 0)}…`;
      case 'set_timer': return 'Starting a timer…';
      case 'add_calendar_event': return 'Adding it to your calendar…';
      case 'compose_message': return 'Drafting a message…';
      case 'share_text': return 'Sharing…';
      case 'open_settings': return 'Opening settings…';
      case 'notifications': return 'Checking your notifications…';
      case 'clipboard': return 'Checking the clipboard…';
      case 'unlock': return 'Unlock your phone to continue';
      case 'phone_status': return 'Checking the phone…';
      default: return 'Working on your phone…';
    }
  }
  switch (name) {
    case 'WebSearch': return i.query ? `Searching for "${i.query}"…` : 'Searching the web…';
    case 'WebFetch': return 'Reading a web page…';
    case 'Bash': return 'Running a command…';
    case 'Read': case 'Glob': case 'Grep': case 'LS': return 'Looking through files…';
    case 'Edit': case 'Write': case 'MultiEdit': return 'Editing a file…';
    case 'TodoWrite': return 'Planning…';
    case 'Task': case 'Agent': return 'Working on it…';
    default: return 'Working on it…';
  }
}

// ---------------------------------------------------------------- views
function useAssist() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    const off = onVoice(f);
    return () => { subs.delete(f); off(); };
  }, []);
}

function Orb() {
  const p = A.phase;
  const busy = p === 'thinking' || p === 'working';
  const tap = () => {
    // a tap meant for the previous state (e.g. "Done" just as listening ended
    // by itself) must not become a different action
    if (busy || Date.now() - phaseAt < 700) return;
    cancelClose();
    if (p === 'listening') stopListening();
    else if (p === 'speaking') { stopSpeaking(); A.followup = false; listen(); }
    else listen();
  };
  const label = { listening: 'Done', thinking: 'Working…', working: 'Working…', speaking: 'Interrupt' }[p] || 'Talk';
  // listening shows a "send" arrow: tapping it always ends your turn and starts the work
  const icon = p === 'listening' ? 'up' : busy ? 'spark' : p === 'speaking' ? 'wave' : 'mic';
  return html`<div class="as-orb-wrap">
    <button class=${'as-orb ' + p} onClick=${tap} aria-label=${label} style=${`--lvl:${p === 'listening' ? V.level : 0}`}>
      <span class="as-orb-ring" /><span class="as-orb-core"><${Icon} name=${icon} size=${26} /></span>
    </button>
    <span class="as-orb-label">${label}</span>
  </div>`;
}

function AskBox() {
  const it = A.ask;
  if (it.tool === 'AskUserQuestion') {
    const q = (it.input.questions || [])[it.qi];
    if (!q) return null;
    return html`<div class="as-ask">
      <div class="as-ask-q">${q.question}</div>
      ${(q.options || []).map((o) => html`<button class="as-opt" onClick=${() => pickAnswer(o.label)}><b>${o.label}</b>${o.description ? html`<span>${o.description}</span>` : null}</button>`)}
    </div>`;
  }
  return html`<div class="as-ask">
    <div class="as-ask-q">${askPrompt(it)}</div>
    <div class="as-ask-row">
      <button class="as-opt no" onClick=${() => decide(false)}>Don't</button>
      <button class="as-opt yes" onClick=${() => decide(true)}>Allow</button>
    </div>
  </div>`;
}

function TypeBox() {
  const [text, setText] = useState('');
  const ref = useRef();
  useEffect(() => {
    setTimeout(() => ref.current && ref.current.focus(), 60);
    return pushBack(() => { A.typing = false; changed(); });
  }, []);
  const submit = (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    A.typing = false;
    if (A.ask) { if (A.ask.tool === 'AskUserQuestion') pickAnswer(t); else answerAskByVoice(t); return; }
    ask(t, false);
  };
  return html`<form class="as-type" onSubmit=${submit}>
    <button type="button" class="as-side" onClick=${() => { A.typing = false; listen(); }} aria-label="Talk instead"><${Icon} name="mic" /></button>
    <input ref=${ref} value=${text} onInput=${(e) => setText(e.target.value)} placeholder="Ask Skiff…" enterkeyhint="send" />
    <button class="as-send" disabled=${!text.trim()} aria-label="Send"><${Icon} name="up" /></button>
  </form>`;
}

function Card() {
  const p = A.phase;
  const you = p === 'listening' ? A.partial : A.heard;
  const placeholder = p === 'listening' && !A.partial ? (A.followup ? 'Anything else?' : 'Listening…') : '';
  const status = p === 'thinking' ? A.step || 'Thinking…' : p === 'idle' && !A.ask && !A.typing ? 'Tap the mic to talk' : p === 'error' ? A.error : '';
  const showAnswer = A.answer && !A.ask && (p === 'speaking' || p === 'answer' || p === 'idle' || (p === 'listening' && A.followup) || (p === 'thinking' && A.live));
  return html`<div class="as-card" onPointerDown=${cancelClose}>
    <div class="as-top">
      <span class="as-brand"><${Icon} name="spark" size=${14} /> Skiff</span>
      <span class="as-grow" />
      <button class="as-icon" onClick=${openInApp} aria-label="Open in Skiff"><${Icon} name="expand" size=${17} /></button>
      <button class="as-icon" onClick=${close} aria-label="Close"><${Icon} name="x" size=${18} /></button>
    </div>
    ${you || placeholder ? html`<div class=${'as-you' + (p === 'listening' ? ' live' : '') + (p !== 'listening' && (showAnswer || status || A.ask) ? ' asked' : '')}>${you || placeholder}</div>` : null}
    ${status ? html`<div class=${'as-status ' + p}>${p === 'thinking' ? html`<span class="as-dots"><i /><i /><i /></span>` : null}<span>${status}</span>
      ${A.errorAction ? html`<button class="as-link" onClick=${A.errorAction[1]}>${A.errorAction[0]}</button>` : null}</div>` : null}
    ${showAnswer ? html`<div class="as-answer"><${Markdown} text=${A.answer} /></div>` : null}
    ${A.ask ? html`<${AskBox} />` : null}
    ${A.typing ? html`<${TypeBox} />` : html`<div class="as-controls">
      <button class="as-side" onClick=${() => { cancelListening(); stopSpeaking(); cancelClose(); A.typing = true; if (A.phase === 'listening' || A.phase === 'speaking') A.phase = 'idle'; changed(); }} aria-label="Type"><${Icon} name="keyboard" /></button>
      <${Orb} />
      ${A.phase === 'thinking' || A.phase === 'working'
        ? html`<button class="as-side as-stop" onClick=${interrupt} aria-label="Stop"><${Icon} name="stop" size=${18} /></button>`
        : html`<span class="as-side-spacer" />`}
    </div>`}
  </div>`;
}

// While Claude is tapping and typing, only this pill stays: everything else
// lets touches through to the app underneath.
function Pill() {
  const ref = useRef();
  const report = () => {
    const r = ref.current && ref.current.getBoundingClientRect();
    if (r) bridge.call('assistTouchRegion', Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height));
  };
  useEffect(() => () => bridge.call('assistTouchFull'), []); // the card takes touches again
  useEffect(report, [A.step]); // the pill's width follows its text
  return html`<div class="as-pill" ref=${ref} onAnimationEnd=${report}>
    <span class="as-pill-spin" />
    <span class="as-pill-text">${A.step || 'Working on your phone…'}</span>
    <button class="as-pill-stop" onClick=${interrupt} aria-label="Stop"><${Icon} name="x" size=${16} /></button>
  </div>`;
}

function App() {
  useAssist();
  const pill = A.phase === 'working' && !A.ask && !A.typing;
  return html`<div class=${'as-root ' + A.phase}>
    ${pill ? null : html`<div class="as-scrim" onClick=${close} />`}
    ${A.phase === 'listening' ? html`<div class="as-glow" style=${`--lvl:${V.level}`} />` : null}
    ${pill ? html`<${Pill} />` : html`<${Card} />`}
  </div>`;
}

// ---------------------------------------------------------------- start
function opened() {
  bridge.call('audioFocus', true);
  if (freshIfStale()) {
    Object.assign(A, { heard: '', answer: '', step: '', ask: null, error: '', followup: false });
    A.pending.clear();
    connect();
  } else if (ws) {
    send({ t: 'warm' });
  }
  A.byVoice = true;
  if (A.busy && !A.ask) { A.phase = 'thinking'; changed(); return; }
  if (!A.ask) listen();
}

window.addEventListener('skiff-assist', opened); // the side button again
window.addEventListener('skiff-assist-hide', () => {
  bridge.call('audioFocus', false);
  cancelClose();
  cancelListening();
  stopSpeaking();
  A.typing = false;
  if (A.phase === 'listening' || A.phase === 'speaking') A.phase = 'idle';
  changed();
});

document.documentElement.classList.add('assist');
render(html`<${App} />`, document.getElementById('app'));
connect();
bridge.call('audioFocus', true); // music and videos pause while we talk
listen();

// Setup, phone settings, logs and about.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, api, store, useStore, onEvent, refreshStatus, toast, bridge, pushBack, setStore } from './core.js';
import { Icon } from './icons.js';
import { openTerminal } from './terminal.js';
import { V, setVoicePref, onVoice, whisperStatus } from './voice.js';
import { Select, Done } from './ui.js';

function SetupCard() {
  const [st, setSt] = useState(null);
  const logRef = useRef();
  useEffect(() => {
    api('/api/setup/state').then(setSt).catch(() => {});
    return onEvent((ev) => {
      if (ev.type !== 'setup') return;
      setSt((prev) => {
        const logs = prev && prev.logs ? mergeLogs(prev.logs, ev.logs || []) : ev.logs || [];
        return { ...ev, logs };
      });
      if (ev.done) refreshStatus();
    });
  }, []);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [st]);
  if (!st) return html`<div class="card"><div class="muted">Loading…</div></div>`;
  if (!st.needed) return html`<div class="card"><h3>Environment</h3><p class="muted">Running on a desktop machine: terminals use your own shell and Claude Code from your PATH.</p></div>`;

  const start = (from) => api('/api/setup/start', from ? { from } : {}).then(() => toast('Setup started')).catch((e) => toast(e.message));
  const pct = st.progress >= 0 ? Math.round(st.progress * 100) : null;
  return html`<div class="card">
    <h3>${st.done ? 'Linux + Claude Code are ready' : 'Set up Linux and Claude Code'}</h3>
    ${!st.done ? html`<p class="muted">Downloads about 250 MB and uses about 1.2 GB of storage. Keep the app open on Wi-Fi; it takes 3–10 minutes.</p>` : null}
    <ol class="steps">${st.steps.map((s) => html`<li class=${s.state}><span class="sdot">${s.state === 'done' ? '✓' : s.state === 'running' ? '' : s.state === 'failed' ? '!' : ''}</span>${s.label}${s.state === 'running' ? html`<span class="spin" />` : null}</li>`)}</ol>
    ${st.running ? html`<div class="progress"><div class=${'bar' + (pct === null ? ' indet' : '')} style=${pct === null ? '' : `width:${pct}%`} /></div><div class="muted small">${st.detail || ''}</div>` : null}
    ${st.error ? html`<div class="warn">${st.error}</div>` : null}
    <div class="row gap wrap">
      ${!st.running && !st.done ? html`<button class="btn primary" onClick=${() => start()}>${st.error ? 'Retry' : st.steps.some((s) => s.state === 'done') ? 'Continue setup' : 'Install'}</button>` : null}
      ${st.done ? html`<button class="btn primary" onClick=${() => openTerminal({ kind: 'claude' })}>✳ Open Claude Code</button>` : null}
      ${!st.running && st.done ? html`<button class="btn" onClick=${() => start('claude')}>Reinstall Claude Code</button>
        <button class="btn" onClick=${() => start('packages')}>Reinstall packages</button>
        <button class="btn danger" onClick=${() => confirm('Delete Ubuntu and all files in it, then reinstall?') && start('rootfs')}>Reset Ubuntu</button>` : null}
    </div>
    ${st.logs && st.logs.length ? html`<details open=${st.running || !!st.error}><summary class="muted small">Setup log</summary><pre class="log" ref=${logRef}>${st.logs.join('\n')}</pre></details>` : null}
  </div>`;
}

function mergeLogs(prev, tail) {
  if (!tail.length) return prev;
  const last = tail[0];
  const i = prev.lastIndexOf(last);
  const merged = i >= 0 ? prev.slice(0, i).concat(tail) : prev.concat(tail);
  return merged.slice(-1500);
}

function PhoneCard() {
  const [, force] = useState(0);
  if (!bridge.present()) return null;
  const keep = bridge.call('isKeepAwake');
  const exempt = bridge.call('isBatteryExempt');
  const storage = bridge.call('hasStorage');
  const r = () => setTimeout(() => force((n) => n + 1), 400);
  return html`<div class="card">
    <h3>Background</h3>
    <div class="set-row"><div><b>Keep running with the screen off</b><div class="muted small">Holds a wake lock so Claude keeps working while the phone sleeps.</div></div>
      <button class=${'toggle' + (keep ? ' on' : '')} onClick=${() => { bridge.call('setKeepAwake', !keep); r(); }}><span /></button></div>
    <div class="set-row"><div><b>Battery optimization</b><div class="muted small">${exempt ? 'Unrestricted: Android won\'t stop Skiff in the background.' : 'Samsung may close Skiff in the background. Allow it to run unrestricted.'}</div></div>
      ${exempt ? html`<${Done} />` : html`<button class="btn small" onClick=${() => { bridge.call('requestBatteryExemption'); r(); }}>Allow</button>`}</div>
    <div class="set-row"><div><b>Phone storage</b><div class="muted small">${storage ? 'Your files are at /sdcard inside Linux.' : 'Let Linux see your Downloads, Documents and other folders at /sdcard.'}</div></div>
      ${storage ? html`<${Done} />` : html`<button class="btn small" onClick=${() => { bridge.call('requestStorage'); r(); }}>Grant</button>`}</div>
    <p class="muted small">Android 14+: if background work still stops, turn on Developer options → "Disable child process restrictions".</p>
  </div>`;
}

// Re-render when the user comes back from an Android settings screen.
function useResumeRefresh() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    const v = () => { if (!document.hidden) setTimeout(f, 300); };
    document.addEventListener('visibilitychange', v);
    window.addEventListener('focus', f);
    const t = setInterval(f, 4000);
    return () => { document.removeEventListener('visibilitychange', v); window.removeEventListener('focus', f); clearInterval(t); };
  }, []);
  return () => setTimeout(() => force((n) => n + 1), 400);
}

const POLICIES = [
  ['risky', 'Risky actions', 'Asks before sending, paying, deleting, calling, and anything in banking or password apps'],
  ['ask', 'Every action', 'Asks before each tap, keystroke or app launch'],
  ['auto', 'Never ask', 'Claude acts without asking. Only if you trust the task.'],
];

function timeOf(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function PhoneControlCard() {
  const r = useResumeRefresh();
  const [showLog, setShowLog] = useState(false);
  if (!bridge.present()) return null;
  let st = {};
  try { st = JSON.parse(bridge.call('phoneState') || '{}'); } catch {}
  const on = !!st.on;
  const policy = st.policy || 'risky';
  const log = (st.log || []).slice().reverse();
  return html`<div class="card">
    <h3><${Icon} name="hand" size=${18} /> Phone control</h3>
    <p class="muted small">Lets Claude use your phone when you ask: read the screen, tap, type, scroll, open apps, play music, set alarms and timers, draft messages. Works from Chat, voice mode, the bubble and Terminal → Claude Code.</p>
    <div class="set-row"><div><b>Allow Claude to use this phone</b><div class="muted small">${on ? 'On. A green banner with Stop shows while Claude is acting.' : st.enabledInSettings ? 'Turned on in Settings but not connected yet. Turn it off and on again.' : 'Android Settings → Accessibility → Installed apps → Skiff phone control → On.'}</div></div>
      ${on ? html`<${Done} />` : html`<button class="btn small primary" onClick=${() => { bridge.call('openAccessibilitySettings'); r(); }}>Turn on</button>`}</div>
    ${!on ? html`<div class="hint-box">
        <b>If Android says "Restricted setting"</b>
        <div class="muted small">Apps installed from a file need one extra step: open Skiff's App info, tap ⋮ (top right) → <i>Allow restricted settings</i>, confirm, then turn Skiff phone control on in Accessibility.</div>
        <button class="btn small" onClick=${() => bridge.call('openAppInfo')}>Open Skiff App info</button>
      </div>` : null}
    ${on && st.stopped ? html`<div class="set-row warnrow"><div><b>Paused</b><div class="muted small">You pressed Stop. Claude's phone actions are refused until you resume.</div></div>
      <button class="btn small" onClick=${() => { bridge.call('setPhoneStopped', false); r(); }}>Resume</button></div>` : null}
    <div class="set-row"><div><b>Ask before</b><div class="muted small">${(POLICIES.find((p) => p[0] === policy) || POLICIES[0])[2]}</div></div>
      <${Select} title="Ask before" value=${policy} options=${POLICIES} onChange=${(v) => { bridge.call('setPhonePolicy', v); r(); }} /></div>
    <p class="muted small">Claude never sees your passwords: Android hides password fields from accessibility apps. Phone actions don't need chat approval; the confirmations above appear on the phone itself.</p>
    ${log.length ? html`<button class="linkish small" onClick=${() => setShowLog(!showLog)}>${showLog ? 'Hide' : 'Show'} recent actions (${log.length})</button>` : null}
    ${showLog ? html`<ul class="actlog">${log.slice(0, 60).map((x) => html`<li><span class="t">${timeOf(x.time)}</span>${x.what || (x.tool || '').replace(/_/g, ' ')}${x.result && x.result !== 'ok' ? html` <span class="tag">${x.result}</span>` : null}</li>`)}</ul>` : null}
  </div>`;
}

function BubbleCard() {
  const r = useResumeRefresh();
  if (!bridge.present()) return null;
  const enabled = bridge.call('bubbleEnabled');
  const canDraw = bridge.call('canDrawOverlays');
  const handsOn = bridge.call('phoneControlOn');
  const running = bridge.call('bubbleRunning');
  const blocked = enabled && !running && !canDraw && !handsOn;
  const toggle = () => {
    if (enabled) { bridge.call('setBubbleEnabled', false); r(); return; }
    bridge.call('setBubbleEnabled', true);
    if (!canDraw) bridge.call('requestOverlay');
    r();
  };
  return html`<div class="card">
    <h3><${Icon} name="bubble" size=${18} /> Chat bubble</h3>
    <div class="set-row"><div><b>Floating Claude bubble</b><div class="muted small">Stays on top of every app. Tap it to chat, drag it anywhere, drag it to ✕ to hide. When Claude works on your phone the chat tucks away so you can watch.</div></div>
      <button class=${'toggle' + (enabled ? ' on' : '')} onClick=${toggle}><span /></button></div>
    ${enabled && !canDraw ? html`<div class="set-row"><div><b>Display over other apps</b><div class="muted small">${handsOn ? 'Optional: phone control already lets the bubble show. Allowing this keeps it working when phone control is off.' : 'Needed so the bubble can float over other apps.'}</div></div>
      <button class="btn small" onClick=${() => { bridge.call('requestOverlay'); r(); }}>Allow</button></div>` : null}
    ${blocked ? html`<p class="warn small">The bubble can't show yet: allow "Display over other apps", or turn on phone control.</p>` : null}
    ${running ? html`<p class="muted small">The bubble hides while Skiff is open and comes back when you leave.</p>` : null}
  </div>`;
}

function AssistantCard() {
  const r = useResumeRefresh();
  if (!bridge.present()) return null;
  const isDefault = bridge.call('isDefaultAssistant');
  const offline = bridge.call('offlineSpeechAvailable');
  return html`<div class="card">
    <h3><${Icon} name="wave" size=${18} /> Side button assistant</h3>
    <p class="muted small">Use Skiff instead of Gemini: press and hold the side button and Skiff opens over whatever you're doing, listens, does it, and answers out loud. Also works on the lock screen.</p>
    <div class="set-row"><div><b>1. Make Skiff your digital assistant</b><div class="muted small">${isDefault ? 'Skiff is your digital assistant.' : 'Settings → Apps → Default apps → Digital assistant app → Device assistance app → Skiff.'}</div></div>
      ${isDefault ? html`<${Done} />` : html`<button class="btn small primary" onClick=${() => { bridge.call('openAssistantSettings'); r(); }}>Choose Skiff</button>`}</div>
    ${!isDefault ? html`<div class="row gap wrap" style="margin:-4px 0 8px"><button class="linkish small" onClick=${() => bridge.call('openDefaultApps')}>Open Default apps instead</button></div>` : null}
    <div class="set-row"><div><b>2. Set the side button</b><div class="muted small">Settings → Advanced features → Side button → Press and hold → Digital assistant. If Samsung offers a ⚙ next to it, that opens the same assistant picker.</div></div></div>
    <div class="set-row"><div><b>Try it</b><div class="muted small">Opens the assistant the way the side button will.</div></div>
      <button class="btn small" disabled=${!isDefault} onClick=${() => { if (!bridge.call('tryAssistant')) toast('Make Skiff your digital assistant first'); }}>Try</button></div>
    <p class="muted small">On the lock screen Skiff answers right away; when a task needs other apps it shows Android's own unlock prompt (fingerprint, face or PIN) first. Claude needs internet; speech can run offline${offline ? ' (Voice → Speech engine → On-device)' : ' with Whisper (Voice card)'}. A "Hey Skiff" wake word isn't possible for apps outside Samsung's partner list.</p>
  </div>`;
}

const LANGS = [['', 'Phone default'], ['en-IN', 'English (India)'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['hi-IN', 'Hindi'], ['pa-IN', 'Punjabi']];

function VoiceCard() {
  const [, force] = useState(0);
  const [ws, setWs] = useState(null);
  const [lines, setLines] = useState([]);
  const ready = store.status && store.status.ready;
  const load = () => whisperStatus().then((d) => { setWs(d); if (d.lines) setLines(d.lines); }).catch(() => {});
  useEffect(() => {
    load();
    const off1 = onVoice(() => force((n) => n + 1));
    const off2 = onEvent((ev) => {
      if (ev.type !== 'voice') return;
      if (ev.line) setLines((l) => [...l, ev.line].slice(-200));
      if (ev.state === 'done') { toast('Whisper is ready'); load(); }
      if (ev.state === 'error') { toast(ev.message, 5000); load(); }
      if (ev.state === 'running') setWs((w) => ({ ...(w || {}), installing: true }));
    });
    return () => { off1(); off2(); };
  }, []);
  const install = () => api('/api/voice/install', {}).then(() => setWs((w) => ({ ...(w || {}), installing: true }))).catch((e) => toast(e.message, 4000));
  return html`<div class="card">
    <h3>Voice</h3>
    <p class="muted small">Tap the mic in Chat to dictate, or the wave icon for voice mode: speak, Claude works, the reply is read aloud, then it listens again.</p>
    <div class="set-row"><div><b>Speech engine</b><div class="muted small">${V.engine === 'whisper' ? 'Runs on your phone inside Ubuntu. Private, works offline.' : V.engine === 'device' ? 'The phone\'s on-device recognizer. Works without internet.' : 'Google or Samsung recognition. Fast, shows words as you speak.'}</div></div>
      <${Select} title="Speech engine" value=${V.engine} onChange=${(v) => setVoicePref('engine', v)}
        options=${[['phone', 'Phone speech', 'Google or Samsung speech recognition'],
          ...(bridge.call('offlineSpeechAvailable') ? [['device', 'On-device', 'The phone\'s offline recognizer: no internet needed for speech']] : []),
          ['whisper', 'Whisper', 'On-device whisper.cpp in Ubuntu']]} /></div>
    <div class="set-row"><div><b>Language</b><div class="muted small">For speech recognition and read-aloud</div></div>
      <${Select} title="Speech language" value=${V.lang} options=${LANGS} onChange=${(v) => setVoicePref('lang', v)} /></div>
    <div class="set-row"><div><b>Read replies aloud</b><div class="muted small">In voice mode</div></div>
      <button class=${'toggle' + (V.speakReplies ? ' on' : '')} onClick=${() => setVoicePref('speakReplies', !V.speakReplies)}><span /></button></div>
    <div class="set-row"><div><b>Whisper (on-device)</b><div class="muted small">${!ws ? 'Checking…' : ws.whisper ? 'Installed (' + ws.model + ').' : ws.installing ? 'Installing: builds whisper.cpp and downloads a 60 MB model. Takes about 5 minutes.' : 'Not installed. Needs about 400 MB (build tools and model).'}</div></div>
      ${ws && !ws.whisper && !ws.installing ? html`<button class="btn small" disabled=${!ready} onClick=${install}>Install</button>` : ws && ws.installing ? html`<span class="spin" />` : html`<${Done} />`}</div>
    ${lines.length && ws && (ws.installing || !ws.whisper) ? html`<pre class="log">${lines.slice(-40).join('\n')}</pre>` : null}
  </div>`;
}

function LogsSheet({ onClose }) {
  const [text, setText] = useState('Loading…');
  useEffect(() => {
    api('/api/logs').then((t) => setText((bridge.call('getAppLog') || '') + '\n--- skiffd ---\n' + t)).catch((e) => setText(e.message));
    return pushBack(onClose);
  }, []);
  return html`<div class="sheet-backdrop" onClick=${onClose}><div class="sheet tall" onClick=${(e) => e.stopPropagation()}>
    <div class="sheet-head"><b>Logs</b><div class="grow" /><button class="btn small" onClick=${() => { bridge.copy(text); toast('Logs copied'); }}><${Icon} name="copy" size=${14} /> Copy</button><button class="icon-btn" onClick=${onClose}><${Icon} name="x" /></button></div>
    <pre class="log full">${text}</pre></div></div>`;
}

export function MoreView() {
  const st = useStore();
  const [logs, setLogs] = useState(false);
  const s = st.status || {};
  return html`<div class="view more">
    <div class="scroll pad col gap">
      <${SetupCard} />
      <${AssistantCard} />
      <${PhoneControlCard} />
      <${BubbleCard} />
      <${PhoneCard} />
      <${VoiceCard} />
      <div class="card">
        <h3>Claude Code usage</h3>
        <p class="muted small"><b>Terminal → Claude</b> is the official interactive Claude Code and uses your plan's normal usage limits. <b>Chat</b> drives Claude Code in headless mode (<code>claude -p</code>), which since June 15, 2026 draws from your plan's separate monthly Agent SDK credit.</p>
        <p class="muted small">Sign in once: open Terminal → Claude Code and type <code>/login</code>. The sign-in page opens in your browser, so Anthropic's own login handles it and Skiff never sees your token.</p>
      </div>
      <div class="card">
        <h3>About</h3>
        <div class="muted small">Skiff ${s.version || ''} · ${s.android ? 'Android' : 'desktop'} · ${s.arch || ''}</div>
        <div class="row gap wrap" style="margin-top:10px">
          <button class="btn small" onClick=${() => setLogs(true)}><${Icon} name="list" size=${14} /> View logs</button>
          ${bridge.present() ? html`<button class="btn small" onClick=${() => bridge.call('restartServer')}><${Icon} name="refresh" size=${14} /> Restart backend</button>` : null}
        </div>
        <p class="muted small">Runs Ubuntu with proot from Termux's packages (GPL-2.0), xterm.js and CodeMirror (MIT), Lucide icons (ISC). Claude Code is installed from Anthropic's official installer and is not modified.</p>
      </div>
    </div>
    ${logs ? html`<${LogsSheet} onClose=${() => setLogs(false)} />` : null}
  </div>`;
}

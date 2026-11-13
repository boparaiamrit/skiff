// Voice input (phone speech recognition or on-device Whisper) and speech output.
import { api, bridge, toast } from './core.js';

export const V = {
  engine: localStorage.getItem('skiff.voiceEngine') || 'phone',
  lang: localStorage.getItem('skiff.voiceLang') || '',
  speakReplies: localStorage.getItem('skiff.voiceSpeak') !== '0',
  listening: false,
  level: 0,
  busy: false, // transcribing
};
const subs = new Set();
export const onVoice = (f) => { subs.add(f); return () => subs.delete(f); };
const changed = () => subs.forEach((f) => f());

export function setVoicePref(k, v) {
  V[k] = v;
  const key = { engine: 'skiff.voiceEngine', lang: 'skiff.voiceLang', speakReplies: 'skiff.voiceSpeak' }[k];
  if (key) localStorage.setItem(key, k === 'speakReplies' ? (v ? '1' : '0') : v);
  changed();
}

let cb = null; // { onPartial, onFinal, onError, vad }
let ttsDone = null;
let pendingStart = null;

// What we have heard so far in this turn. Phone recognizers differ: some
// keep listening long after you stop, some answer "no match" when stopped
// by hand even though they showed your words. We keep the last words and
// finish the turn ourselves when the recognizer doesn't.
const L = { partial: '', lastChange: 0, started: 0, watch: 0, fallback: 0 };
const SILENCE_MS = 1800; // no new words for this long → done
const QUIET_MS = 1000; // your voice dropped back to the room's noise for this long → done
const MAX_MS = 30000;

// Microphone level, cleaned up: we follow the room's background noise and
// only count what rises above it as voice, then smooth it so the visuals
// don't flicker with every sound.
const LV = { floor: 0.15, smooth: 0, lastLoud: 0 };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
function onLevel(raw) {
  raw = clamp01(raw);
  LV.floor = raw < LV.floor ? LV.floor * 0.6 + raw * 0.4 : LV.floor + (raw - LV.floor) * 0.008;
  const voice = clamp01((raw - LV.floor - 0.1) / (1 - LV.floor));
  LV.smooth = LV.smooth * 0.8 + voice * 0.2;
  if (voice > 0.3) LV.lastLoud = Date.now();
  V.level = LV.smooth;
  changed();
}

function clearTurn() {
  clearInterval(L.watch); clearTimeout(L.fallback);
  L.watch = 0; L.fallback = 0;
}

// hand the result over exactly once
function deliver(text, reason) {
  const c = cb; cb = null;
  clearTurn();
  V.listening = false; V.level = 0; changed();
  if (c && c.onFinal) c.onFinal(text, reason);
}

// the recognizer should answer now; if it doesn't, use what we heard
function armFallback(ms) {
  if (L.fallback) return;
  L.fallback = setTimeout(() => {
    L.fallback = 0;
    if (!cb) return;
    bridge.call('cancelListening');
    deliver(L.partial, L.partial ? undefined : 'silence');
  }, ms);
}

function finishPhoneTurn() {
  bridge.call('stopListening');
  armFallback(L.partial ? 900 : 2500);
}

// events from the Android app
window.skiffVoice = (ev) => {
  switch (ev.type) {
    case 'partial':
      if (!cb) return;
      if ((ev.text || '').trim() && ev.text !== L.partial) { L.partial = ev.text.trim(); L.lastChange = Date.now(); }
      cb.onPartial && cb.onPartial(ev.text || '');
      break;
    case 'final': {
      if (!cb) return;
      deliver((ev.text || '').trim() || L.partial);
      break;
    }
    case 'end': // the recognizer noticed you stopped talking
      if (cb) armFallback(L.partial ? 1500 : 4000);
      break;
    case 'level': onLevel((ev.db + 2) / 12); break;
    case 'error': {
      if (!cb) return;
      const code = String(ev.error);
      if (code === 'permission') {
        V.listening = false; changed();
        const c = cb; cb = null; clearTurn();
        toast('Allow the microphone, then tap the mic again');
        pendingStart = c;
        return;
      }
      // words were already on screen: keep them rather than losing the turn
      if (L.partial) { deliver(L.partial); return; }
      if (code === 'unavailable') toast('No speech recognition service on this phone. Switch to Whisper in Setup → Voice.', 5000);
      // 6 = no speech, 7 = no match: just nothing was said
      deliver('', code === '6' || code === '7' ? 'silence' : code);
      break;
    }
    case 'permission':
      if (ev.granted && pendingStart) { const c = pendingStart; pendingStart = null; startListening(c); }
      break;
    case 'tts-done': { const f = ttsDone; ttsDone = null; f && f(); break; }
  }
};

// ---- Whisper: record 16 kHz mono PCM in the page, transcribe in Ubuntu ----
const W = { stream: null, ctx: null, node: null, chunks: [], heard: false, quietSince: 0, started: 0 };

async function whisperStart(c) {
  try {
    W.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    V.listening = false; changed();
    toast('Microphone blocked: allow it for Skiff and try again');
    bridge.call('requestMic');
    c.onFinal && c.onFinal('', 'permission');
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  W.ctx = new AC({ sampleRate: 16000 });
  const src = W.ctx.createMediaStreamSource(W.stream);
  W.node = W.ctx.createScriptProcessor(4096, 1, 1);
  W.chunks = []; W.heard = false; W.quietSince = 0; W.started = Date.now(); W.noise = 0; W.frames = 0;
  W.node.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    W.chunks.push(new Float32Array(d));
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    const rms = Math.sqrt(sum / d.length);
    LV.smooth = LV.smooth * 0.8 + Math.min(1, rms * 12) * 0.2;
    V.level = LV.smooth; changed();
    if (!c.vad) return;
    const now = Date.now();
    // learn the room's background noise in the first moments, then judge speech against it
    W.frames++;
    if (W.frames <= 2) { W.noise = Math.max(W.noise, rms); return; }
    W.noise = W.heard ? W.noise : W.noise * 0.95 + rms * 0.05;
    const speech = Math.max(0.02, W.noise * 3);
    const quiet = Math.max(0.012, W.noise * 1.8);
    if (rms > speech) { W.heard = true; W.quietSince = 0; } else if (W.heard && rms < quiet && !W.quietSince) W.quietSince = now;
    if ((W.heard && W.quietSince && now - W.quietSince > 1300) || now - W.started > MAX_MS) stopListening();
    else if (!W.heard && now - W.started > 8000) stopListening(); // nobody spoke
  };
  src.connect(W.node);
  W.node.connect(W.ctx.destination);
}

function encodeWav(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

async function whisperStop() {
  const c = cb; cb = null;
  const heard = W.heard || !(c && c.vad);
  try { W.node && W.node.disconnect(); } catch {}
  try { W.stream && W.stream.getTracks().forEach((t) => t.stop()); } catch {}
  const rate = W.ctx ? W.ctx.sampleRate : 16000;
  try { W.ctx && W.ctx.close(); } catch {}
  const chunks = W.chunks; W.chunks = [];
  V.listening = false; V.level = 0;
  if (!heard || !chunks.length) { changed(); c && c.onFinal && c.onFinal('', 'silence'); return; }
  V.busy = true; changed();
  try {
    const lang = (V.lang || '').split('-')[0] || 'auto';
    const r = await fetch('/api/voice/transcribe?lang=' + lang, { method: 'POST', body: encodeWav(chunks, rate) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    c && c.onFinal && c.onFinal(d.text || '');
  } catch (e) {
    toast(e.message, 4000);
    c && c.onFinal && c.onFinal('', 'error');
  } finally { V.busy = false; changed(); }
}

// ---- public API ----
export function startListening(c) {
  if (V.listening) return;
  cb = c;
  clearTurn();
  Object.assign(L, { partial: '', lastChange: 0, started: Date.now() });
  LV.lastLoud = 0; LV.smooth = 0;
  V.listening = true; V.level = 0; changed();
  if (V.engine === 'whisper') whisperStart(c);
  else if (bridge.present()) {
    bridge.call(V.engine === 'device' && bridge.call('offlineSpeechAvailable') ? 'listenOffline' : 'listen', V.lang || '');
    // end the turn when you stop talking, even if the recognizer doesn't
    L.watch = setInterval(() => {
      if (!cb) { clearTurn(); return; }
      const now = Date.now();
      const quiet = LV.lastLoud && now - Math.max(L.lastChange, LV.lastLoud) > QUIET_MS;
      if (c.vad !== false && L.partial && (quiet || now - L.lastChange > SILENCE_MS)) { clearInterval(L.watch); L.watch = 0; finishPhoneTurn(); }
      else if (now - L.started > MAX_MS) { clearInterval(L.watch); L.watch = 0; finishPhoneTurn(); }
    }, 200);
  } else {
    V.listening = false; cb = null; changed();
    toast('Phone speech needs the Skiff app; use Whisper on a desktop');
  }
}

/** "I'm done talking": always ends the turn with whatever was heard. */
export function stopListening() {
  if (!V.listening || !cb) return;
  if (V.engine === 'whisper') whisperStop();
  else finishPhoneTurn();
}

export function cancelListening() {
  clearTurn();
  cb = null;
  if (V.engine === 'whisper') {
    try { W.stream && W.stream.getTracks().forEach((t) => t.stop()); W.ctx && W.ctx.close(); } catch {}
  } else bridge.call('cancelListening');
  V.listening = false; V.level = 0; changed();
}

// Markdown → something pleasant to hear.
export function speakable(md) {
  let t = md
    .replace(/```[\s\S]*?```/g, ' (code in the chat) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*|__|\*|_|~~/g, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/([.!?:;])\s*\.(\s|$)/g, '$1$2')
    .trim();
  if (t.length > 1400) t = t.slice(0, 1400).replace(/\s\S*$/, '') + '. The rest is in the chat.';
  return t;
}

export function speak(text, done) {
  ttsDone = done;
  if (bridge.present()) bridge.call('speak', text, V.lang || '');
  else if (window.speechSynthesis) {
    const u = new SpeechSynthesisUtterance(text);
    if (V.lang) u.lang = V.lang;
    u.onend = u.onerror = () => { const f = ttsDone; ttsDone = null; f && f(); };
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } else setTimeout(() => { const f = ttsDone; ttsDone = null; f && f(); }, 10);
}

export function stopSpeaking() {
  ttsDone = null;
  if (bridge.present()) bridge.call('stopSpeaking');
  else if (window.speechSynthesis) speechSynthesis.cancel();
}

export const whisperStatus = () => api('/api/voice/status');

import { HologramScene } from './avatar/hologramScene.js';
import { createRecognizer, isSpeechRecognitionSupported } from './voice/speechRecognition.js';
import {
  configureSpeechSynthesis,
  isSpeechSynthesisSupported, speakText, cancelSpeech, pickIndonesianVoice, getVoices
} from './voice/speechSynthesis.js';
import UI from './ui/controls.js';
import { loadAppConfig, getBackendBaseUrl } from './appConfig.js';

const APP_CONFIG = await loadAppConfig();
const APP = APP_CONFIG.app || {};
const BACKEND_BASE_URL = getBackendBaseUrl(APP_CONFIG);
const FEATURES = APP_CONFIG.features || {};
const TTS_CFG = APP_CONFIG.tts || {};
const STT_CFG = APP_CONFIG.stt || {};
const AVATAR_CFG = APP_CONFIG.avatar || {};

function applyAppBranding(config) {
  const app = config.app || {};
  if (app.name) document.title = app.subtitle ? `${app.name} — ${app.subtitle}` : app.name;
  const h1 = document.querySelector('.brand-text h1');
  const sub = document.querySelector('.brand-text p');
  if (h1 && app.name) h1.textContent = app.name;
  if (sub && app.subtitle) sub.textContent = app.subtitle;
  const footer = document.querySelectorAll('.footer span');
  if (footer[0] && app.footerLeft != null) footer[0].textContent = app.footerLeft;
  if (footer[1] && app.footerRight != null) footer[1].textContent = app.footerRight;
  const infoPanel = document.querySelector('.info-panel');
  if (infoPanel) infoPanel.style.display = config.features?.showDebugPanels ? '' : 'none';
  const header = document.querySelector('.header');
  if (header) header.style.display = config.features?.showDebugPanels ? '' : 'none';
  const footerEl = document.querySelector('.footer');
  if (footerEl) footerEl.style.display = config.features?.showDebugPanels ? '' : 'none';
}

applyAppBranding(APP_CONFIG);
configureSpeechSynthesis({
  backendBaseUrl: BACKEND_BASE_URL,
  defaultSpeaker: TTS_CFG.defaultVoice || TTS_CFG.defaultSpeaker || 'brian',
  rate: TTS_CFG.rate ?? 0.88,
  pitch: TTS_CFG.pitch ?? 1.0,
  volume: TTS_CFG.volume ?? 1.0,
  backendFirst: TTS_CFG.backendFirst !== false,
  defaultLang: APP.language || 'id-ID'
});

// ---------- State machine ----------
const STATE = { IDLE: 'IDLE', LISTENING: 'LISTENING', PROCESSING: 'PROCESSING', SPEAKING: 'SPEAKING', ERROR: 'ERROR' };
let state = STATE.IDLE;
let autoListen = false;
let recordAfterSpeak = false;
let recognizer = null;
let recognitionActive = false;
let networkRetries = 0;
let speakToken = 0;
let flowToken = 0;            // increments on start/cancel to invalidate stale async flows
let sessionActive = false;    // true after "Mulai" until user clicks "Selesai"
let activeRecording = null;   // { cancelled, cancel() } for in-flight mic capture
const MAX_NETWORK_RETRIES = Number(STT_CFG.maxNetworkRetries ?? 3);

const avatarCanvas = document.getElementById('avatarCanvas');
const waveCanvas = document.getElementById('waveCanvas');
const waveCtx = waveCanvas.getContext('2d');

// ---------- Avatar ----------
const avatar = new HologramScene(avatarCanvas, {
  backgroundPath: AVATAR_CFG.backgroundPath,
  videos: AVATAR_CFG.videos,
  imageWidth: AVATAR_CFG.imageWidth,
  fitScale: AVATAR_CFG.fitScale,
  positionStorageKey: AVATAR_CFG.positionStorageKey
});

function showAppBubble(text) {
  const b = document.getElementById('appBubble');
  if (!b) return;
  b.textContent = text || '';
  b.style.display = text ? 'block' : 'none';
}
function showUserBubble(text) {
  const b = document.getElementById('userBubble');
  if (!b) return;
  b.textContent = text || '';
  b.style.display = text ? 'block' : 'none';
}

// ---------- Draggable question bubble ----------
(function makeQuestionBubbleDraggable() {
  const bubble = document.getElementById('userBubble');
  if (!bubble) return;
  const KEY = 'pupr-question-bubble-position';
  let dragging = false;
  let offsetX = 0, offsetY = 0;
  let moved = false;
  const clampPosition = (left, top) => {
    const rect = bubble.getBoundingClientRect();
    return {
      left: Math.min(Math.max(left, 0), Math.max(0, window.innerWidth - rect.width)),
      top: Math.min(Math.max(top, 0), Math.max(0, window.innerHeight - rect.height)),
    };
  };
  const clampCurrent = () => {
    const rect = bubble.getBoundingClientRect();
    const pos = clampPosition(rect.left, rect.top);
    bubble.style.left = pos.left + 'px';
    bubble.style.top = pos.top + 'px';
    bubble.style.right = 'auto';
    bubble.style.bottom = 'auto';
    bubble.style.transform = 'none';
    return pos;
  };
  const savePosition = () => {
    try {
      const rect = bubble.getBoundingClientRect();
      localStorage.setItem(KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    } catch {}
  };
  const restorePosition = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        bubble.style.left = saved.left + 'px';
        bubble.style.top = saved.top + 'px';
        bubble.style.right = 'auto';
        bubble.style.bottom = 'auto';
        bubble.style.transform = 'none';
        requestAnimationFrame(clampCurrent);
      }
    } catch {}
  };
  const start = (e) => {
    if (!bubble || bubble.style.display === 'none') return;
    const rect = bubble.getBoundingClientRect();
    dragging = true;
    moved = false;
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    bubble.style.cursor = 'grabbing';
    bubble.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const move = (e) => {
    if (!dragging) return;
    moved = true;
    const pos = clampPosition(e.clientX - offsetX, e.clientY - offsetY);
    bubble.style.left = pos.left + 'px';
    bubble.style.top = pos.top + 'px';
    bubble.style.right = 'auto';
    bubble.style.bottom = 'auto';
    bubble.style.transform = 'none';
  };
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    bubble.style.cursor = 'grab';
    bubble.releasePointerCapture?.(e.pointerId);
    if (moved) savePosition();
  };
  bubble.addEventListener('pointerdown', start);
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  restorePosition();
  clampCurrent();
})();

// ---------- Draggable answer bubble (bottom-center default) ----------
(function makeBubbleDraggable() {
  const bubble = document.getElementById('appBubble');
  if (!bubble) return;
  const KEY = 'pupr-answer-bubble-position';
  let dragging = false;
  let offsetX = 0, offsetY = 0;
  let moved = false;
  const clampPosition = (left, top) => {
    const rect = bubble.getBoundingClientRect();
    return {
      left: Math.min(Math.max(left, 0), Math.max(0, window.innerWidth - rect.width)),
      top: Math.min(Math.max(top, 0), Math.max(0, window.innerHeight - rect.height)),
    };
  };
  const clampCurrent = () => {
    const rect = bubble.getBoundingClientRect();
    const pos = clampPosition(rect.left, rect.top);
    bubble.style.left = pos.left + 'px';
    bubble.style.top = pos.top + 'px';
    bubble.style.right = 'auto';
    bubble.style.bottom = 'auto';
    bubble.style.transform = 'none';
    return pos;
  };
  const savePosition = () => {
    try {
      const rect = bubble.getBoundingClientRect();
      localStorage.setItem(KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    } catch {}
  };
  const restorePosition = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        bubble.style.left = saved.left + 'px';
        bubble.style.top = saved.top + 'px';
        bubble.style.right = 'auto';
        bubble.style.bottom = 'auto';
        bubble.style.transform = 'none';
        requestAnimationFrame(clampCurrent);
      }
    } catch {}
  };
  const start = (e) => {
    if (!bubble || bubble.style.display === 'none') return;
    const rect = bubble.getBoundingClientRect();
    dragging = true;
    moved = false;
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    bubble.style.cursor = 'grabbing';
    bubble.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const move = (e) => {
    if (!dragging) return;
    moved = true;
    const pos = clampPosition(e.clientX - offsetX, e.clientY - offsetY);
    bubble.style.left = pos.left + 'px';
    bubble.style.top = pos.top + 'px';
    bubble.style.right = 'auto';
    bubble.style.bottom = 'auto';
    bubble.style.transform = 'none';
  };
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    bubble.style.cursor = 'grab';
    bubble.releasePointerCapture?.(e.pointerId);
    if (moved) savePosition();
  };
  bubble.addEventListener('pointerdown', start);
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  window.addEventListener('resize', clampCurrent);
  restorePosition();
  clampCurrent();
})();

// ---------- Waveform (visual status) ----------
let wavePhase = 0;
function drawWave() {
  const w = waveCanvas.width;
  const h = waveCanvas.height;
  waveCtx.clearRect(0, 0, w, h);
  waveCtx.fillStyle = 'rgba(0, 0, 0, 0.25)';
  waveCtx.fillRect(0, 0, w, h);

  const bars = 48;
  const barW = w / bars;
  const active = (state === STATE.LISTENING || state === STATE.SPEAKING);
  wavePhase += active ? 0.18 : 0.05;
  for (let i = 0; i < bars; i++) {
    const v = active
      ? (Math.sin(wavePhase + i * 0.35) * 0.5 + 0.5) * (0.3 + Math.random() * 0.7)
      : 0.08;
    const bh = v * (h - 8);
    const x = i * barW + 2;
    const y = (h - bh) / 2;
    const grad = waveCtx.createLinearGradient(0, y, 0, y + bh);
    grad.addColorStop(0, 'rgba(0,229,255,0.9)');
    grad.addColorStop(1, 'rgba(30,136,229,0.6)');
    waveCtx.fillStyle = grad;
    waveCtx.fillRect(x, y, barW - 3, bh);
  }
  requestAnimationFrame(drawWave);
}
drawWave();

// ---------- State helpers ----------
function setState(next) {
  state = next;
  avatar.setState(next);
  UI.setStatus(next);
  UI.setButtons({ listening: state === STATE.LISTENING, speaking: state === STATE.SPEAKING });
  if (next === STATE.SPEAKING) UI.setSpeakingIndicator(true);
  else UI.setSpeakingIndicator(false);
}

function friendlyError(code, msg) {
  const map = {
    'not-allowed': 'Izin mikrofon ditolak. Aktifkan izin mikrofon di pengaturan browser.',
    'service-not-allowed': 'Layanan pengenalan suara tidak diizinkan.',
    'audio-capture': 'Mikrofon tidak ditemukan atau tidak dapat diakses.',
    'no-speech': 'Tidak ada suara terdeteksi. Coba ulangi.',
    'network': 'Gangguan jaringan pada layanan pengenalan suara.',
    'aborted': 'Pengenalan suara dibatalkan.',
    'start-failed': 'Gagal memulai pengenalan suara.'
  };
  return map[code] || `Kesalahan pengenalan suara: ${code}${msg ? ' — ' + msg : ''}`;
}

// ---------- Recognition ----------
function startListening() {
  if (recognitionActive) return;
  if (!recognizer || !recognizer.supported) {
    setState(STATE.ERROR);
    UI.showError('Browser tidak mendukung SpeechRecognition. Gunakan Google Chrome.');
    return;
  }
  recognitionActive = true;
  UI.setMic(true);
  setState(STATE.LISTENING);

  recognizer.start();
}

function stopListening() {
  if (recognizer) recognizer.stop();
  recognitionActive = false;
  UI.setMic(false);
}

function handleFinal(text) {
  if (state !== STATE.LISTENING) return;
  recognitionActive = false;
  UI.setMic(false);
  stopListening();
  showUserBubble(text);
  speakEcho(text);
}

function speakEcho(text, opts = {}) {
  if (!text) {
    setState(STATE.IDLE);
    if (sessionActive) setTimeout(() => { startRecordingFlow(); }, 300);
    else if (autoListen) startListening();
    return;
  }
  const token = ++speakToken;
  const myFlow = flowToken;
  const hideText = !!opts.hideText;
  if (hideText) {
    UI.setSpokenText('');
    showAppBubble('');
  } else {
    UI.setSpokenText(text);
    showAppBubble(text);
  }
  setState(STATE.SPEAKING);

  const voiceSelect = document.getElementById('voiceSelect');
  const selectedSpeaker = (voiceSelect && voiceSelect.value) ? voiceSelect.value : (TTS_CFG.defaultVoice || TTS_CFG.defaultSpeaker || 'brian');
  const result = speakText(text, {
    lang: APP.language || 'id-ID',
    rate: TTS_CFG.rate ?? 0.88,
    pitch: TTS_CFG.pitch ?? 1.0,
    speaker: selectedSpeaker,
    backendFirst: TTS_CFG.backendFirst !== false,
    backendBaseUrl: BACKEND_BASE_URL,
    voice: null, // biarkan browser pilih suara default untuk bahasa terpilih (lebih andal)
    onStart: (_voice, meta = {}) => {
      if (token !== speakToken || myFlow !== flowToken) return;
      const estimatedDuration = Math.max(1.2, text.length / (10.5 * 0.95));
      const duration = (meta && meta.duration > 0) ? meta.duration : estimatedDuration;
      // Switch to speaking video only when audio actually starts, to keep in sync.
      avatar.setActiveVideo('speaking');
      avatar.setSpeechText(text, duration);
    },
    onEnd: () => {
      if (token !== speakToken || myFlow !== flowToken) return;
      avatar.setActiveVideo('standby');
      if (!hideText) UI.setSpokenText(text);
      setState(STATE.IDLE);
      // After speaking: if session still active, wait for the next question; otherwise honor legacy autoListen.
      if (sessionActive) {
        recordAfterSpeak = false;
        setTimeout(() => { if (sessionActive && myFlow === flowToken) startRecordingFlow(); }, 500);
      } else if (recordAfterSpeak) {
        recordAfterSpeak = false;
        setTimeout(() => { startRecordingFlow(); }, 500);
      }
    },
    onError: (code) => {
      if (token !== speakToken || myFlow !== flowToken) return;
      setState(STATE.ERROR);
      if (code === 'not-supported') {
        UI.showError('Browser tidak mendukung Text-to-Speech.');
      } else if (code !== 'CANCELLED' && code !== 'cancelled') {
        UI.showError(`Gagal membacakan suara: ${code}`);
      }
      UI.setSpeakingIndicator(false);
      if (sessionActive) {
        // keep session alive: return to listening for next question instead of ending
        setTimeout(() => { if (sessionActive && myFlow === flowToken) { setState(STATE.IDLE); startRecordingFlow(); } }, 1200);
      } else if (autoListen) {
        setTimeout(() => { if (state === STATE.ERROR) { setState(STATE.IDLE); startListening(); } }, 1200);
      }
    }
  });

  if (!result.supported) {
    setState(STATE.ERROR);
    UI.showError('Browser tidak mendukung Text-to-Speech.');
  }
}

function stopAll() {
  speakToken++;
  cancelSpeech();
  stopListening();
  recognitionActive = false;
  UI.setMic(false);
  setState(STATE.IDLE);
  UI.showError('');
}

function repeatLast() {
  UI.showError('Belum ada ucapan yang dapat diulang.');
}

// ---------- Network error handling ----------
function handleNetworkError(code, msg) {
  recognitionActive = false;
  UI.setMic(false);
  if (code === 'no-speech') {
    setState(STATE.IDLE);
    if (autoListen) {
      setTimeout(() => { if (state === STATE.IDLE) startListening(); }, 500);
    }
    return;
  }
  if (code === 'network') {
    if (networkRetries < MAX_NETWORK_RETRIES) {
      networkRetries++;
      UI.showError(`Gangguan jaringan pada layanan pengenalan suara. Mencoba lagi (${networkRetries}/${MAX_NETWORK_RETRIES})...`);
      setState(STATE.IDLE);
      const retryDelay = Number(STT_CFG.retryDelayMs ?? 1000);
      setTimeout(() => { if (state === STATE.IDLE) startListening(); }, retryDelay * networkRetries);
      return;
    }
    // Batas maksimal tercapai: laporkan kegagalan permanen, jangan lagi coba otomatis.
    setState(STATE.ERROR);
    UI.showError('Gagal mengenali suara: batas maksimal percobaan tercapai. Periksa koneksi internet, gunakan localhost/HTTPS, nonaktifkan VPN/ad-blocker yang memblokir layanan Google, lalu coba lagi.');
    return;
  }
  setState(STATE.ERROR);
  UI.showError(friendlyError(code, msg));
}

// ---------- Recognizer setup ----------
recognizer = (FEATURES.browserSpeechRecognitionFallback === false && !FEATURES.sttEnabled)
  ? { supported: false, start() {}, stop() {} }
  : createRecognizer({
      lang: APP.language || 'id-ID',
      onFinal: (t) => { handleFinal(t); },
      onError: (code, msg) => { handleNetworkError(code, msg); },
      onStart: () => {
        recognitionActive = true;
        networkRetries = 0;
      },
      onEnd: () => {
        recognitionActive = false;
        if (state === STATE.LISTENING) {
          setState(STATE.IDLE);
          UI.setMic(false);
          if (autoListen) {
            setTimeout(() => { if (state === STATE.IDLE) startListening(); }, 500);
          }
        }
      }
    });

// ---------- Capabilities ----------
function updateCaps() {
  const voices = getVoices();
  const idVoice = pickIndonesianVoice(voices);
  const browser = navigator.userAgent.includes('Chrome') ? 'Chrome' : navigator.userAgent.split(' ').pop();
  UI.updateCapabilities({
    sr: isSpeechRecognitionSupported(),
    tts: isSpeechSynthesisSupported(),
    idVoice: !!idVoice,
    browser
  });
  const idVoiceInfo = document.getElementById('idVoiceInfo');
  if (idVoiceInfo && idVoice) idVoiceInfo.textContent = idVoice.name;
}
updateCaps();
if (isSpeechSynthesisSupported()) {
  window.speechSynthesis.onvoiceschanged = updateCaps;
}

// ---------- Controls binding ----------
document.getElementById('btnStart').addEventListener('click', () => {
  UI.showError('');
  // Reset counter bila tombol ditekan ulang agar retry tidak terus-menerus ditumpuk.
  networkRetries = 0;
  if (state === STATE.IDLE || state === STATE.ERROR) {
    setState(STATE.IDLE);
    startListening();
  }
});
document.getElementById('btnStop').addEventListener('click', () => {
  stopAll();
});
document.getElementById('btnRepeat').addEventListener('click', () => {
  UI.showError('');
  repeatLast();
});
const autoToggle = document.getElementById('autoListen');
autoToggle.addEventListener('change', (e) => {
  autoListen = e.target.checked;
});
autoListen = false;

// Manual text echo fallback (optional element)
const manualTextInput = document.getElementById('manualText');
const btnEchoText = document.getElementById('btnEchoText');
if (manualTextInput && btnEchoText) {
  btnEchoText.addEventListener('click', () => {
    const t = (manualTextInput.value || '').trim();
    if (!t) { UI.showError('Ketik teks terlebih dahulu.'); return; }
    UI.showError('');
    stopAll();
    speakEcho(t);
  });
  manualTextInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnEchoText.click(); });
}

// ---------- STT/AI backend (configurable) ----------
const STT_URL = `${BACKEND_BASE_URL}/stt`;
const AI_URL = `${BACKEND_BASE_URL}/ai`;

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function encodeWAV(samples, sampleRate) {
  const pcm = floatTo16BitPCM(samples);
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++) { view.setInt16(off, pcm[i], true); off += 2; }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function recordUntilSilence(silenceMs) {
  silenceMs = silenceMs || Number(STT_CFG.silenceMs ?? 1500);
  const maxRecordMs = Number(STT_CFG.maxRecordMs ?? 15000);      // hard cap: never record forever
  const noSpeechTimeoutMs = Number(STT_CFG.noSpeechTimeoutMs ?? 7000); // if no speech detected, stop and retry
  const THRESH = Number(STT_CFG.silenceThreshold ?? 0.008);      // slightly more sensitive than 0.012
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let startedTalking = false;
  let lastSound = Date.now();
  let consecutiveSound = 0;
  let cancelled = false;
  let resolveWait = null;
  let maxRms = 0;
  const startedAt = Date.now();

  const cleanup = async () => {
    try { processor.disconnect(); } catch {}
    try { source.disconnect(); } catch {}
    try { stream.getTracks().forEach((track) => track.stop()); } catch {}
    try { await audioCtx.close(); } catch {}
  };
  activeRecording = {
    get cancelled() { return cancelled; },
    cancel: () => { cancelled = true; if (resolveWait) resolveWait(); }
  };

  processor.onaudioprocess = (e) => {
    if (cancelled) return;
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    // copy buffer (ScriptProcessor reuses underlying buffer)
    const copy = new Float32Array(data.length);
    copy.set(data);
    chunks.push(copy);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    if (rms > maxRms) maxRms = rms;
    if (rms > THRESH) {
      consecutiveSound++;
      if (consecutiveSound >= 1) { // 1 frame is enough (reduces missed short utterances)
        startedTalking = true;
        lastSound = Date.now();
      }
    } else {
      consecutiveSound = 0;
    }
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);
  await new Promise((resolve) => {
    resolveWait = resolve;
    const iv = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const silenceElapsed = Date.now() - lastSound;
      const noSpeech = !startedTalking && elapsed >= noSpeechTimeoutMs;
      const maxedOut = elapsed >= maxRecordMs;
      const endAfterSpeech = startedTalking && silenceElapsed >= silenceMs;
      if (cancelled || noSpeech || maxedOut || endAfterSpeech) {
        clearInterval(iv);
        resolve();
      }
    }, 150);
  });

  await cleanup();
  const rec = activeRecording;
  activeRecording = null;
  if (cancelled || (rec && rec.cancelled)) {
    const err = new Error('CANCELLED');
    err.code = 'CANCELLED';
    throw err;
  }
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
  console.log('[stt-capture]', { startedTalking, totalSamples: total, sampleRate: audioCtx.sampleRate, maxRms: Number(maxRms.toFixed(5)), durationSec: Number(((Date.now()-startedAt)/1000).toFixed(2)) });
  if (total <= 0) {
    const err = new Error('NO_AUDIO');
    err.code = 'NO_AUDIO';
    throw err;
  }
  const samples = new Float32Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    samples.set(chunk, pos);
    pos += chunk.length;
  }
  return encodeWAV(samples, audioCtx.sampleRate);
}

async function transcribe(wavBlob) {
  const fd = new FormData();
  fd.append('audio', wavBlob, 'audio.wav');
  let res;
  try {
    res = await fetch(STT_URL, { method: 'POST', body: fd });
  } catch {
    throw new Error('Backend pengenalan suara tidak merespons. Pastikan backend berjalan di ' + BACKEND_BASE_URL + '.');
  }
  // The backend may answer with HTML (proxy/500 page); never let that hide the real problem.
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!res.ok) throw new Error((data && data.error) ? String(data.error) : `Layanan pengenalan suara gagal (HTTP ${res.status}).`);
  return (data && data.text) ? data.text : '';
}

async function askAI(userText) {
  if (FEATURES.aiEnabled === false) return { ok: false, noTts: true, reason: 'disabled' };
  try {
    const res = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: userText })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error) ? String(data.error) : `AI gagal memproses jawaban (HTTP ${res.status})`;
      return { ok: false, noTts: true, error: msg, status: res.status };
    }
    const text = (data && data.text) ? String(data.text).trim() : '';
    if (!text) return { ok: false, noTts: true, error: 'AI tidak mengembalikan jawaban.' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, noTts: true, error: (e && e.message) ? e.message : 'AI tidak tersedia.' };
  }
}

async function startRecordingFlow() {
  if (!sessionActive) return;
  const myFlow = flowToken;
  setState(STATE.LISTENING);
  UI.setMic(true);
  avatar.setActiveVideo('standby');
  // Listening text is hidden by design (only window UI / mic indicator remains).
  showAppBubble('');
  const iv = setInterval(() => {
    if (!sessionActive || myFlow !== flowToken) { clearInterval(iv); return; }
    showAppBubble('');
  }, 500);
  try {
    const wav = await recordUntilSilence(1500);
    clearInterval(iv);
    if (!sessionActive || myFlow !== flowToken) return;
    UI.setMic(false);
    setState(STATE.PROCESSING);
    avatar.setActiveVideo('standby');
    showAppBubble('');
    const text = await transcribe(wav);
    if (!sessionActive || myFlow !== flowToken) return;
    if (text && text.trim()) {
      showUserBubble(text);
      showAppBubble('');
      const ai = await askAI(text);
      if (!sessionActive || myFlow !== flowToken) return;
      if (!ai || !ai.ok || !ai.text) {
        // ERROR: jangan kirim ke TTS (jangan ucapkan error/echo). Tampilkan status singkat lalu lanjut dengarkan.
        const errMsg = (ai && ai.error) ? String(ai.error) : 'AI tidak tersedia.';
        console.warn('[AI] no reply, TTS skipped:', errMsg);
        UI.setSpokenText('');
        showAppBubble('Maaf, layanan AI belum siap. Silakan coba lagi.');
        setState(STATE.IDLE);
        if (sessionActive && myFlow === flowToken) setTimeout(() => { if (sessionActive && myFlow === flowToken) startRecordingFlow(); }, 1200);
        return;
      }
      showAppBubble(''); // hide hasil jawaban
      speakEcho(ai.text, { hideText: true }); // onEnd continues to next question while sessionActive
    } else {
      // no speech detected -> keep waiting for next question
      showAppBubble('Saya belum mendengar pertanyaan. Silakan coba lagi.');
      setState(STATE.IDLE);
      UI.setMic(false);
      setTimeout(() => { if (sessionActive && myFlow === flowToken) startRecordingFlow(); }, 900);
    }
  } catch (e) {
    clearInterval(iv);
    UI.setMic(false);
    if (e && (e.code === 'CANCELLED' || e.message === 'CANCELLED')) return;
    if (!sessionActive || myFlow !== flowToken) return;
    showAppBubble('Gagal memproses suara: ' + (e && e.message ? e.message : e));
    setState(STATE.IDLE);
    // recover: keep session active and listen again
    setTimeout(() => { if (sessionActive && myFlow === flowToken) startRecordingFlow(); }, 1200);
  }
}

let welcomeAudio = null;
function playWelcomeSound() {
  return new Promise((resolve) => {
    const token = ++speakToken;
    const myFlow = flowToken;
    try { cancelSpeech(); } catch {}
    try { if (welcomeAudio) { welcomeAudio.pause(); welcomeAudio.currentTime = 0; } } catch {}
    const audio = new Audio('./public/selamat_datang.mp3');
    welcomeAudio = audio;
    UI.setSpokenText(APP.greeting || 'Selamat datang');
    showAppBubble(APP.greeting || 'Selamat datang di Dinas Pekerjaan Umum Kabupaten Sukabumi');
    setState(STATE.SPEAKING);

    let settled = false;
    const after = (ok) => {
      if (settled) return;
      settled = true;
      if (token !== speakToken || myFlow !== flowToken) { resolve(ok); return; }
      try { avatar.setActiveVideo('standby'); } catch {}
      UI.setSpokenText(APP.greeting || '');
      setState(STATE.IDLE);
      if (sessionActive) {
        setTimeout(() => { if (sessionActive && myFlow === flowToken) startRecordingFlow(); }, 500);
      }
      resolve(ok);
    };

    audio.onloadedmetadata = () => {
      if (token !== speakToken || myFlow !== flowToken) return;
      const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Math.max(1.2, (APP.greeting || '').length / 10);
      try { avatar.setSpeechText(APP.greeting || 'selamat datang', dur); } catch {}
    };
    audio.onplay = () => {
      if (token !== speakToken || myFlow !== flowToken) return;
      try { avatar.setActiveVideo('speaking'); } catch {}
    };
    audio.onended = () => after(true);
    audio.onerror = () => after(false);

    const p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(() => after(false));
  });
}

function setMulaiButton(running) {
  const btn = document.getElementById('btnMulai');
  if (!btn) return;
  btn.textContent = running ? 'Selesai' : 'Mulai';
  btn.dataset.mode = running ? 'stop' : 'start';
  btn.style.background = running ? '#ff6b6b' : '#00e5ff';
  btn.style.boxShadow = running ? '0 0 18px rgba(255,107,107,0.45)' : '0 0 18px rgba(0,229,255,0.5)';
}

function finishSession() {
  sessionActive = false;
  recordAfterSpeak = false;
  flowToken++;           // invalidate any in-flight callbacks/timeouts/recording flow
  speakToken++;
  try { cancelSpeech(); } catch {}
  try { stopListening(); } catch {}
  try { if (activeRecording && activeRecording.cancel) activeRecording.cancel(); } catch {}
  activeRecording = null;
  UI.setMic(false);
  avatar.setActiveVideo('standby');
  showAppBubble('Sesi selesai. Tekan Mulai untuk bertanya lagi.');
  showUserBubble('');
  setState(STATE.IDLE);
  setMulaiButton(false);
}

// ---------- Mulai / Selesai button ----------
const btnMulai = document.getElementById('btnMulai');
if (btnMulai) {
  setMulaiButton(false);
  btnMulai.addEventListener('click', async () => {
    if (sessionActive) {
      finishSession();
      return;
    }
    // Start conversation session: play welcome sound, then keep listening until "Selesai"
    sessionActive = true;
    recordAfterSpeak = false; // controlled by sessionActive flow
    UI.showError('');
    setMulaiButton(true);
    const ok = await playWelcomeSound();
    if (!ok && sessionActive) {
      // fallback to TTS greeting if mp3 missing/blocked
      speakEcho(APP.greeting || 'selamat datang');
    }
  });
}

// ---------- Initial state ----------
setState(STATE.IDLE);
if (!isSpeechRecognitionSupported()) {
  UI.showError('Browser tidak mendukung SpeechRecognition. Gunakan Google Chrome di desktop.');
}
if (!isSpeechSynthesisSupported()) {
  UI.showError('Browser tidak mendukung Text-to-Speech.');
}

document.addEventListener('visibilitychange', () => {
  // keep as-is
});

window.addEventListener('beforeunload', () => {
  stopAll();
  avatar.dispose();
});

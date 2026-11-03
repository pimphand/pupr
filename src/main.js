import { HologramScene } from './avatar/hologramScene.js';
import { createRecognizer, isSpeechRecognitionSupported } from './voice/speechRecognition.js';
import {
  isSpeechSynthesisSupported, speakText, cancelSpeech, pickIndonesianVoice, getVoices
} from './voice/speechSynthesis.js';
import UI from './ui/controls.js';

// ---------- State machine ----------
const STATE = { IDLE: 'IDLE', LISTENING: 'LISTENING', PROCESSING: 'PROCESSING', SPEAKING: 'SPEAKING', ERROR: 'ERROR' };
let state = STATE.IDLE;
let autoListen = false;
let recordAfterSpeak = false;
let recognizer = null;
let recognitionActive = false;
let networkRetries = 0;
let speakToken = 0;
const MAX_NETWORK_RETRIES = 3;

const avatarCanvas = document.getElementById('avatarCanvas');
const waveCanvas = document.getElementById('waveCanvas');
const waveCtx = waveCanvas.getContext('2d');

// ---------- Avatar ----------
const avatar = new HologramScene(avatarCanvas);

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

// ---------- Draggable chat bubble ----------
(function makeBubbleDraggable() {
  const bubble = document.getElementById('appBubble');
  if (!bubble) return;
  let dragging = false;
  let offsetX = 0, offsetY = 0;
  const start = (e) => {
    const pt = e.touches ? e.touches[0] : e;
    const rect = bubble.getBoundingClientRect();
    dragging = true;
    offsetX = pt.clientX - rect.left;
    offsetY = pt.clientY - rect.top;
    bubble.style.transform = 'none';
    bubble.style.left = rect.left + 'px';
    bubble.style.top = rect.top + 'px';
    bubble.style.cursor = 'grabbing';
    e.preventDefault();
  };
  const move = (e) => {
    if (!dragging) return;
    const pt = e.touches ? e.touches[0] : e;
    bubble.style.left = (pt.clientX - offsetX) + 'px';
    bubble.style.top = (pt.clientY - offsetY) + 'px';
  };
  const end = () => { dragging = false; bubble.style.cursor = 'grab'; };
  bubble.style.cursor = 'grab';
  bubble.addEventListener('mousedown', start);
  bubble.addEventListener('touchstart', start, { passive: false });
  window.addEventListener('mousemove', move);
  window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('mouseup', end);
  window.addEventListener('touchend', end);
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

function speakEcho(text) {
  if (!text) {
    setState(STATE.IDLE);
    if (autoListen) startListening();
    return;
  }
  const token = ++speakToken;
  UI.setSpokenText(text);
  showAppBubble(text);
  setState(STATE.SPEAKING);

  const voiceSelect = document.getElementById('voiceSelect');
  const selectedSpeaker = voiceSelect ? voiceSelect.value : 'wibowo';
  const result = speakText(text, {
    lang: 'id-ID',
    rate: 0.95,
    pitch: 1.0,
    speaker: selectedSpeaker,
    voice: null, // biarkan browser pilih suara default untuk id-ID (lebih andal)
    onStart: (_voice, meta = {}) => {
      const estimatedDuration = Math.max(1.2, text.length / (10.5 * 0.95));
      const duration = (meta && meta.duration > 0) ? meta.duration : estimatedDuration;
      // Switch to speaking video only when audio actually starts, to keep in sync.
      avatar.setActiveVideo('speaking');
      avatar.setSpeechText(text, duration);
    },
    onEnd: () => {
      if (token !== speakToken) return;
      setState(STATE.IDLE);
      avatar.setActiveVideo('standby');
      UI.setSpokenText(text);
      if (recordAfterSpeak) {
        recordAfterSpeak = false;
        setTimeout(() => { startRecordingFlow(); }, 500);
      }
    },
    onError: (code) => {
      if (token !== speakToken) return;
      setState(STATE.ERROR);
      if (code === 'not-supported') {
        UI.showError('Browser tidak mendukung Text-to-Speech.');
      } else {
        UI.showError(`Gagal membacakan suara: ${code}`);
      }
      UI.setSpeakingIndicator(false);
      if (autoListen) {
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
      setTimeout(() => { if (state === STATE.IDLE) startListening(); }, 1000 * networkRetries);
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
recognizer = createRecognizer({
  lang: 'id-ID',
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

// ---------- STT backend ----------
const STT_URL = 'http://127.0.0.1:8767/stt';
const OPENAI_API_KEY = (typeof localStorage !== 'undefined' && localStorage.getItem('openai_key')) || '';

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
  silenceMs = silenceMs || 2500;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let startedTalking = false;
  let lastSound = 0;
  let consecutiveSound = 0;
  const THRESH = 0.012;

  processor.onaudioprocess = (e) => {
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    chunks.push(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    if (rms > THRESH) {
      consecutiveSound++;
      if (consecutiveSound >= 2) {
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
    const iv = setInterval(() => {
      if (startedTalking && Date.now() - lastSound >= silenceMs) {
        clearInterval(iv);
        resolve();
      }
    }, 200);
  });

  processor.disconnect();
  source.disconnect();
  stream.getTracks().forEach((track) => track.stop());
  await audioCtx.close();
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
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
  const res = await fetch(STT_URL, { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'STT gagal');
  return (data && data.text) ? data.text : '';
}

async function askAI(userText) {
  try {
    const res = await fetch('http://127.0.0.1:8767/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: userText })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI gagal memproses jawaban');
    return (data && data.text) ? data.text : null;
  } catch (e) {
    showAppBubble(e.message || 'AI tidak tersedia.');
    return null;
  }
}

async function startRecordingFlow() {
  avatar.setActiveVideo('standby');
  showAppBubble('Mendengarkan...');
  const t0 = Date.now();
  const iv = setInterval(() => {
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    showAppBubble('Mendengarkan... ' + sec + 's');
  }, 500);
  try {
    const wav = await recordUntilSilence(1500);
    clearInterval(iv);
    avatar.setActiveVideo('standby');
    showAppBubble('Memproses...');
    const text = await transcribe(wav);
    if (text && text.trim()) {
      showUserBubble(text);
      showAppBubble('Berpikir...');
      const reply = await askAI(text);
      if (reply) {
        showAppBubble(reply);
        recordAfterSpeak = true;
        speakEcho(reply);
      } else {
        // no AI key/result: fallback echo
        showAppBubble(text);
        recordAfterSpeak = true;
        speakEcho(text);
      }
    } else {
      // belum ada suara -> tetap standby
      showAppBubble('');
    }
  } catch (e) {
    showAppBubble('Gagal merekam: ' + (e && e.message ? e.message : e));
  }
}

// ---------- Mulai button ----------
const btnMulai = document.getElementById('btnMulai');
if (btnMulai) {
  btnMulai.addEventListener('click', () => {
    if (state !== STATE.IDLE && state !== STATE.ERROR) return;
    recordAfterSpeak = true;
    speakEcho('selamat datang di Dinas Pekerjaan Umum Kabupaten Sukabumi');
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

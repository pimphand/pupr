import '/src/style.css';
import { HologramScene } from '/src/avatar/hologramScene.js';
import { createRecognizer, isSpeechRecognitionSupported } from '/src/voice/speechRecognition.js';
import {
  isSpeechSynthesisSupported, speakText, cancelSpeech, pickIndonesianVoice, getVoices
} from '/src/voice/speechSynthesis.js';
import UI from '/src/ui/controls.js';

// ---------- State machine ----------
const STATE = { IDLE: 'IDLE', LISTENING: 'LISTENING', PROCESSING: 'PROCESSING', SPEAKING: 'SPEAKING', ERROR: 'ERROR' };
let state = STATE.IDLE;
let autoListen = true;
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
  setState(STATE.SPEAKING);

  const result = speakText(text, {
    lang: 'id-ID',
    rate: 0.95,
    pitch: 1.0,
    voice: null, // biarkan browser pilih suara default untuk id-ID (lebih andal)
    onStart: () => {
      // Fallback animasi berbasis teks untuk browser yang tidak mengirim boundary event.
      const estimatedDuration = Math.max(1.5, text.length / (10 * 0.95));
      avatar.setSpeechText(text, estimatedDuration);
    },
    onBoundary: (ev) => {
      if (!ev || (ev.name && ev.name !== 'word')) return;
      const spokenWord = text.slice(ev.charIndex || 0, (ev.charIndex || 0) + (ev.charLength || 1));
      if (!spokenWord.trim()) return;
      // Boundary TTS menjaga awal tiap kata tepat; bentuk mulut dipilih dari hurufnya.
      avatar.setSpeechWord(spokenWord, Math.max(0.18, spokenWord.length * 0.11 / 0.95));
    },
    onEnd: () => {
      if (token !== speakToken) return;
      setState(STATE.IDLE);
      UI.setSpokenText(text);
      if (autoListen) {
        setTimeout(() => {
          if (state === STATE.IDLE && autoListen) startListening();
        }, 800);
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
autoListen = autoToggle.checked;

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

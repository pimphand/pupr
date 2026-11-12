let ttsConfig = {
  backendBaseUrl: 'https://p.dwiki.id',
  defaultSpeaker: 'brian',
  rate: 1,
  pitch: 1,
  volume: 1,
  backendFirst: true,
  defaultLang: 'id-ID'
};

export function configureSpeechSynthesis(config = {}) {
  ttsConfig = { ...ttsConfig, ...config };
}

export function isSpeechSynthesisSupported() {
  return !!window.speechSynthesis && !!window.SpeechSynthesisUtterance;
}

export function getVoices() {
  if (!isSpeechSynthesisSupported()) return [];
  try { return window.speechSynthesis.getVoices(); } catch (e) { return []; }
}

export function pickIndonesianVoice(voices) {
  const list = voices || getVoices();
  const langPrefix = String(ttsConfig.defaultLang || 'id').toLowerCase().split('-')[0];
  const matching = list.filter((v) => (v.lang || '').toLowerCase().startsWith(langPrefix));
  if (matching.length) return matching[0];
  return list.length ? list[0] : null;
}

function speakWithBrowser(text, opts = {}) {
  if (!isSpeechSynthesisSupported()) return { supported: false };
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voice = (opts.voice !== undefined && opts.voice !== null) ? opts.voice : null;
  const lang = opts.lang || ttsConfig.defaultLang || 'id-ID';
  if (voice) {
    u.voice = voice;
    u.lang = (voice.lang && voice.lang !== u.lang) ? voice.lang : lang;
  } else {
    u.lang = lang;
  }
  u.rate = (opts.rate !== undefined) ? opts.rate : (ttsConfig.rate ?? 1);
  u.pitch = (opts.pitch !== undefined) ? opts.pitch : (ttsConfig.pitch ?? 1);
  u.volume = (opts.volume !== undefined) ? opts.volume : (ttsConfig.volume ?? 1);
  let ended = false;
  const finish = (cb) => { if (ended) return; ended = true; if (cb) cb(); };
  if (opts.onStart) {
    u.onstart = () => {
      const estimated = Math.max(1.2, (text.length / 11) / (u.rate || 1));
      lipSync.mode = 'browser';
      lipSync.active = true;
      lipSync.startedAt = performance.now();
      lipSync.duration = estimated;
      lipSync.energy = 0.45;
      opts.onStart(voice, { duration: estimated, source: 'browser' });
    };
  }
  if (opts.onEnd) u.onend = () => { stopLipSync(); finish(opts.onEnd); };
  if (opts.onError) u.onerror = (e) => { stopLipSync(); finish(() => opts.onError(e.error || 'unknown')); };
  if (opts.onBoundary) u.onboundary = opts.onBoundary;
  const estimatedMs = Math.max(1500, (text.length / 10) * 1000 / (u.rate || 1));
  setTimeout(() => {
    if (!ended) {
      try { synth.cancel(); } catch (e) {}
      stopLipSync();
      finish(opts.onEnd);
      if (opts.onError) opts.onError('timeout');
    }
  }, estimatedMs + 5000);
  synth.speak(u);
  return { supported: true, utterance: u };
}

export async function tryBackendTTS(text, opts = {}) {
  try {
    const baseUrl = String(opts.backendBaseUrl || ttsConfig.backendBaseUrl || '').replace(/\/$/, '');
    if (!baseUrl) return null;
    const res = await fetch(`${baseUrl}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, speaker: opts.speaker || opts.voice || ttsConfig.defaultSpeaker || 'brian', voice: opts.voice || opts.speaker || ttsConfig.defaultSpeaker || 'brian' })
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.playbackRate = opts.rate ?? ttsConfig.rate ?? 1;
    let ended = false;
    const finish = (cb) => { if (ended) return; ended = true; currentAudio = null; try { URL.revokeObjectURL(url); } catch (e) {} if (cb) cb(); };
    attachLipSync(audio);
    audio.onplay = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : null;
      lipSync.mode = 'audio';
      lipSync.active = true;
      lipSync.duration = duration || 0;
      if (opts.onStart) opts.onStart(null, { duration, source: 'backend' });
    };
    audio.onended = () => { stopLipSync(); finish(opts.onEnd); };
    audio.onerror = () => { stopLipSync(); finish(() => opts.onError && opts.onError('audio-error')); };
    currentAudio = audio;
    if (audio.readyState < 1) {
      await new Promise((resolve) => {
        const done = () => { audio.removeEventListener('loadedmetadata', done); resolve(); };
        audio.addEventListener('loadedmetadata', done);
        setTimeout(done, 400);
      });
    }
    await audio.play();
    return { supported: true, audio };
  } catch (e) {
    return null;
  }
}

export function speakText(text, opts = {}) {
  const merged = { ...ttsConfig, ...opts };
  if (merged.backendFirst === false) {
    speakWithBrowser(text, merged);
    return { supported: true };
  }
  // Try backend TTS first, fall back to browser TTS.
  tryBackendTTS(text, merged).then((result) => {
    if (!result) {
      speakWithBrowser(text, merged);
    }
  }).catch(() => {
    speakWithBrowser(text, merged);
  });
  return { supported: true };
}

let currentAudio = null;
let audioContext = null;
let analyser = null;
let mediaSource = null;
const analyserBins = new Uint8Array(256);

const lipSync = {
  mode: null,
  active: false,
  startedAt: 0,
  duration: 0,
  energy: 0
};

function getAudioContext() {
  if (!audioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioContext = new Ctx();
  }
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}

function attachLipSync(audio) {
  const ctx = getAudioContext();
  if (!ctx) {
    lipSync.energy = 0.4;
    return;
  }
  try {
    if (mediaSource) {
      try { mediaSource.disconnect(); } catch (e) {}
      mediaSource = null;
    }
    mediaSource = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.55;
    mediaSource.connect(analyser);
    analyser.connect(ctx.destination);
  } catch (e) {
    lipSync.energy = 0.4;
  }
}

function sampleEnergy() {
  if (!analyser) return lipSync.energy || 0.4;
  analyser.getByteTimeDomainData(analyserBins);
  let sum = 0;
  for (let i = 0; i < analyserBins.length; i++) {
    const v = (analyserBins[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / analyserBins.length);
}

function stopLipSync() {
  lipSync.active = false;
  lipSync.mode = null;
  lipSync.energy = 0;
}

export function getSpeechClock() {
  if (lipSync.mode === 'audio' && currentAudio) {
    const duration = Number.isFinite(currentAudio.duration) ? currentAudio.duration : lipSync.duration;
    lipSync.duration = duration || lipSync.duration;
    lipSync.energy = sampleEnergy();
    return {
      active: lipSync.active && !currentAudio.ended,
      time: currentAudio.currentTime || 0,
      duration: lipSync.duration || 0,
      energy: lipSync.energy
    };
  }
  if (lipSync.mode === 'browser' && lipSync.active) {
    return {
      active: true,
      time: (performance.now() - lipSync.startedAt) / 1000,
      duration: lipSync.duration || 0,
      energy: 0.42
    };
  }
  return { active: false, time: 0, duration: 0, energy: 0 };
}

export function cancelSpeech() {
  stopLipSync();
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.currentTime = 0; } catch (e) {}
    currentAudio = null;
  }
  if (window.speechSynthesis) {
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }
}

export default { configureSpeechSynthesis, isSpeechSynthesisSupported, getVoices, pickIndonesianVoice, speakText, cancelSpeech, tryBackendTTS, getSpeechClock };

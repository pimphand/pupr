export function isSpeechSynthesisSupported() {
  return !!window.speechSynthesis && !!window.SpeechSynthesisUtterance;
}

export function getVoices() {
  if (!isSpeechSynthesisSupported()) return [];
  try { return window.speechSynthesis.getVoices(); } catch (e) { return []; }
}

export function pickIndonesianVoice(voices) {
  const list = voices || getVoices();
  const idVoices = list.filter((v) => (v.lang || '').toLowerCase().startsWith('id'));
  if (idVoices.length) return idVoices[0];
  return list.length ? list[0] : null;
}

export function speakText(text, opts = {}) {
  if (!isSpeechSynthesisSupported()) return { supported: false };
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  // Jangan kirimkan objek voice mentah ke SpeechSynthesisUtterance. Namun, walaupun
  // dirujuk dari daftar suara browser, beberapa browser akan mengabaikan (never
  // synthesize) suara yang voiceURI-nya tidak dikenal. Salin atribut yang dibaca
  // utamanya: voiceURI dan lang, sehingga peramban menggunakan suara yang diminta.
  const voice = (opts.voice !== undefined && opts.voice !== null) ? opts.voice : null;
  if (voice) {
    u.voice = voice;
    u.lang = (voice.lang && voice.lang !== u.lang) ? voice.lang : (opts.lang || 'id-ID');
  } else {
    u.lang = opts.lang || 'id-ID';
  }
  u.rate = (opts.rate !== undefined) ? opts.rate : 1;
  u.pitch = (opts.pitch !== undefined) ? opts.pitch : 1;
  u.volume = (opts.volume !== undefined) ? opts.volume : 1;
  let ended = false;
  const finish = (cb) => { if (ended) return; ended = true; if (cb) cb(); };
  if (opts.onStart) u.onstart = () => { opts.onStart(voice); };
  if (opts.onEnd) u.onend = () => { finish(opts.onEnd); };
  if (opts.onError) u.onerror = (e) => { finish(() => opts.onError(e.error || 'unknown')); };
  if (opts.onBoundary) u.onboundary = opts.onBoundary;
  const estimatedMs = Math.max(1500, (text.length / 10) * 1000 / (u.rate || 1));
  setTimeout(() => {
    if (!ended) {
      try { synth.cancel(); } catch (e) {}
      finish(opts.onEnd);
      if (opts.onError) opts.onError('timeout');
    }
  }, estimatedMs + 5000);
  synth.speak(u);
  return { supported: true, utterance: u };
}

export function cancelSpeech() {
  if (window.speechSynthesis) {
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }
}

export default { isSpeechSynthesisSupported, getVoices, pickIndonesianVoice, speakText, cancelSpeech };
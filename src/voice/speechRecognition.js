export function isSpeechRecognitionSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function createRecognizer(options = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    return { supported: false, start() {}, stop() {} };
  }
  const r = new SR();
  r.lang = options.lang || 'id-ID';
  r.continuous = options.continuous ?? false;
  r.interimResults = options.interimResults ?? true;
  r.maxAlternatives = options.maxAlternatives ?? 1;

  r.onstart = () => { if (options.onStart) options.onStart(); };
  r.onresult = (e) => {
    let interim = '';
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    if (interim.trim() && options.onInterim) options.onInterim(interim.trim());
    if (final.trim() && options.onFinal) options.onFinal(final.trim());
  };
  r.onerror = (e) => {
    if (options.onError) options.onError(e.error || 'unknown', e.message || '');
  };
  r.onend = () => {
    if (options.onEnd) options.onEnd();
  };

  return {
    supported: true,
    start() { try { r.start(); } catch (e) { console.warn(e); } },
    stop() { try { r.stop(); } catch (e) { console.warn(e); } }
  };
}
export default { isSpeechRecognitionSupported, createRecognizer };
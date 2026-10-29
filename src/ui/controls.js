const el = (id) => document.getElementById(id);

export const UI = {
  setStatus(s) {
    const label = el('stateLabel');
    if (label) label.textContent = s;
    const pill = el('statePill');
    if (pill) pill.className = 'status-pill ' + (s === 'ERROR' ? 'err' : s === 'SPEAKING' ? 'ok' : s === 'LISTENING' ? 'active' : '');
  },
  setButtons({ listening, speaking }) {
    const start = el('btnStart');
    const stop = el('btnStop');
    if (start) start.disabled = (listening || speaking);
    if (stop) stop.disabled = !(listening || speaking);
  },
  setSpeakingIndicator(v) {
    const ind = el('speakingIndicator');
    if (ind) ind.hidden = !v;
  },
  setMic(active) {
    const micLabel = el('micLabel');
    if (micLabel) micLabel.textContent = 'Mikrofon: ' + (active ? 'Aktif' : 'Nonaktif');
    const micPill = el('micPill');
    if (micPill) micPill.className = 'status-pill ' + (active ? 'active' : '');
  },
  setSpokenText(t) {
    const e = el('spokenText');
    if (e) { e.textContent = t; e.className = 'transcript hologram'; }
  },
  showError(msg) {
    const e = el('errorBox');
    if (!e) return;
    if (msg) { e.textContent = msg; e.hidden = false; }
    else { e.hidden = true; }
  },
  updateCapabilities({ sr, tts, idVoice, browser }) {
    const b = el('browserInfo'); if (b) b.textContent = browser || '—';
    const s = el('srSupport'); if (s) s.textContent = sr ? 'Tersedia' : 'Tidak';
    const t = el('ttsSupport'); if (t) t.textContent = tts ? 'Tersedia' : 'Tidak';
    const i = el('idVoiceInfo'); if (i) i.textContent = idVoice ? 'Tersedia' : 'Tidak';
  }
};

export default UI;
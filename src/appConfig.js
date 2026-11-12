const DEFAULT_CONFIG = {
  app: {
    name: 'Resepsionis Virtual PUPR',
    subtitle: 'Holographic Echo System',
    organization: 'Dinas PUPR',
    greeting: 'selamat datang di Dinas Pekerjaan Umum Kabupaten Sukabumi',
    language: 'id-ID',
    footerLeft: 'Prototipe Simulasi',
    footerRight: ''
  },
  backend: {
    enabled: true,
    host: '127.0.0.1',
    port: 8767,
    baseUrl: 'https://p.dwiki.id'
  },
  features: {
    sttEnabled: true,
    ttsEnabled: true,
    aiEnabled: true,
    browserSpeechRecognitionFallback: true,
    recordAfterSpeak: true,
    showDebugPanels: false
  },
  tts: {
    provider: 'databyte',
    defaultSpeaker: 'brian',
    defaultVoice: 'brian',
    model: 'elevenlabs/eleven-v3-conversational',
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    backendFirst: true
  },
  stt: {
    silenceMs: 1500,
    maxNetworkRetries: 3,
    retryDelayMs: 1000
  },
  avatar: {
    backgroundPath: './public/background.png',
    videos: {
      standby: './public/karakter_baru/stanby.mp4',
      speaking: './public/video.mp4'
    },
    imageWidth: 3.55,
    fitScale: 0.72,
    positionStorageKey: 'pupr-avatar-character-position-v4'
  },
  ai: {
    systemPrompt: '',
    maxHistoryMessages: 12,
    maxTextChars: 800,
    maxReplyChars: 1200,
    cooldownSeconds: 2
  }
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override ?? base;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(override)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base?.[k] === 'object' && !Array.isArray(base?.[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

let cached = null;

async function loadRuntimeConfigFromApi(config) {
  // Runtime AI/config defaults (language/tts/ai prompt & limits) are managed in dashboard DB and exposed by backend API.
  if (config?.backend?.enabled === false) return null;
  try {
    const base = getBackendBaseUrl(config || DEFAULT_CONFIG);
    const res = await fetch(`${base}/api-config`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.ok === false) return null;
    const out = {};
    if (data.app && typeof data.app === 'object') out.app = data.app; // e.g. language
    if (data.tts && typeof data.tts === 'object') out.tts = data.tts; // e.g. defaultSpeaker
    if (data.ai && typeof data.ai === 'object') out.ai = data.ai;   // systemPrompt + limits
    if (data.backend && typeof data.backend === 'object') out.backend = data.backend;
    return out;
  } catch (e) {
    console.warn('[config] Failed to load runtime config from backend API, using file/default config:', e?.message || e);
    return null;
  }
}

export async function loadAppConfig() {
  if (cached) return cached;
  let merged = DEFAULT_CONFIG;
  try {
    const res = await fetch('./app.config.json', { cache: 'no-store' });
    if (res.ok) {
      merged = deepMerge(DEFAULT_CONFIG, await res.json());
    }
  } catch (e) {
    console.warn('[config] Failed to load app.config.json, using defaults:', e);
  }
  // Prefer values from dashboard DB via backend API (ai/systemPrompt, limits, language, tts speaker)
  const apiCfg = await loadRuntimeConfigFromApi(merged);
  if (apiCfg) merged = deepMerge(merged, apiCfg);
  cached = merged;
  return cached;
}

export function getBackendBaseUrl(config) {
  const b = config?.backend || {};
  if (b.baseUrl) return String(b.baseUrl).replace(/\/$/, '');
  const host = b.host || '127.0.0.1';
  const port = b.port || 8767;
  return `http://${host}:${port}`;
}

export default { loadAppConfig, getBackendBaseUrl };

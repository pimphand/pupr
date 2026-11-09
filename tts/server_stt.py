import os
import re
import sys
import tempfile
import hashlib
import json as _json
import threading
import time
import urllib.request
import urllib.parse
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from pathlib import Path
import speech_recognition as sr
from flask import Flask, request, jsonify
from flask_cors import CORS


def load_env_file(path, override=False):
    if not path or not os.path.exists(path):
        return False
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                k = k.strip()
                v = v.strip()
                if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                    v = v[1:-1]
                if override or not os.environ.get(k):
                    os.environ[k] = v
        return True
    except Exception as e:
        print('[env] Failed to load', path, repr(e), flush=True)
        return False


# Load local env fallback first (process/env vars still take precedence over file values below)
# Packaged/Windows: config/.env/.tts-cache should live in a writable per-user dir, not bundled app resources.
def _resolve_app_root():
    env_root = (os.environ.get('PUPR_APP_ROOT') or '').strip()
    if env_root and os.path.isdir(env_root):
        return Path(env_root).resolve()
    return Path(__file__).resolve().parent

def _resolve_data_dir():
    # Explicit override (Electron passes PUPR_USER_DATA=app.getPath('userData'))
    for k in ('PUPR_USER_DATA', 'PUPR_DATA_DIR'):
        v = (os.environ.get(k) or '').strip()
        if v:
            try:
                p = Path(v); p.mkdir(parents=True, exist_ok=True); return p
            except Exception:
                pass
    if os.name == 'nt':
        base = os.environ.get('APPDATA') or os.path.expanduser('~')
        p = Path(base) / 'ResepsionisVirtualPUPR'; p.mkdir(parents=True, exist_ok=True); return p
    p = Path.home() / '.resepsionis-virtual-pupr'; p.mkdir(parents=True, exist_ok=True); return p

APP_ROOT = _resolve_app_root()
DATA_DIR = _resolve_data_dir()
BASE_DIR_PATH = APP_ROOT  # compat name used later
# Load env from data dir first (user config), then app root (dev fallback). Never override existing env.
load_env_file(str(DATA_DIR / '.env'), override=False)
load_env_file(str(APP_ROOT / '.env'), override=False)

# Load PUPR API keys from Dashboard DB (preferred source). Dashboard stores them in public.app_settings.
_is_frozen = bool(getattr(sys, 'frozen', False))

def _load_backend_cfg_hint():
    # Lightweight read of app.config.json backend dashboard settings (works for packaged/userData .env/config setups).
    for cp in [os.environ.get('APP_CONFIG_PATH'), str(DATA_DIR / 'app.config.json'), str(APP_ROOT / 'app.config.json'), os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app.config.json')]:
        try:
            if cp and os.path.exists(cp):
                with open(cp, 'r', encoding='utf-8') as f:
                    cfg = _json.load(f) or {}
                b = (cfg.get('backend') or {}) if isinstance(cfg, dict) else {}
                if isinstance(b, dict): return b
        except Exception:
            continue
    return {}

_backend_hint = _load_backend_cfg_hint()
_default_dash = '' if _is_frozen else 'http://localhost:4321/api/pupr/config'
# Precedence: process env (explicit) > app.config.json backend.dashboardConfigUrl > dev default (localhost) > empty when frozen.
DASHBOARD_CONFIG_URL = (os.environ.get('DASHBOARD_CONFIG_URL') or (_backend_hint.get('dashboardConfigUrl') or '') or _default_dash).strip()
DASHBOARD_USAGE_URL = (os.environ.get('DASHBOARD_USAGE_URL') or (_backend_hint.get('dashboardUsageUrl') or '') or '').strip()
DASHBOARD_CONVERSATION_URL = (os.environ.get('DASHBOARD_CONVERSATION_URL') or (_backend_hint.get('dashboardConversationUrl') or '') or '').strip()
DASHBOARD_CONFIG_TOKEN = (os.environ.get('DASHBOARD_CONFIG_TOKEN') or os.environ.get('PUPR_CONFIG_TOKEN') or (_backend_hint.get('dashboardConfigToken') or '') or '').strip()
try:
    DASHBOARD_CONFIG_TIMEOUT = float(os.environ.get('DASHBOARD_CONFIG_TIMEOUT') or (_backend_hint.get('dashboardConfigTimeout') or 4.0))
except Exception:
    DASHBOARD_CONFIG_TIMEOUT = 4.0

def _derive_dashboard_urls():
    global DASHBOARD_USAGE_URL, DASHBOARD_CONVERSATION_URL
    base = (DASHBOARD_CONFIG_URL or '').strip().rstrip('/')
    if not base:
        DASHBOARD_USAGE_URL = ''; DASHBOARD_CONVERSATION_URL = ''; return
    if base.endswith('/api/pupr/config'):
        root = base[:-len('/api/pupr/config')]
        if not DASHBOARD_USAGE_URL: DASHBOARD_USAGE_URL = root + '/api/pupr/usage'
        if not DASHBOARD_CONVERSATION_URL: DASHBOARD_CONVERSATION_URL = root + '/api/pupr/conversation'
    # Dev-only localhost convenience: if still missing and not frozen, fall back to localhost (never for remote/custom URLs)
    if not _is_frozen:
        if not DASHBOARD_USAGE_URL and 'localhost' in base or '127.0.0.1' in base or '[::1]' in base:
            pass
_derive_dashboard_urls()


def _is_loopback_dashboard_url(url):
    try:
        h = (urllib.parse.urlparse(url or '').hostname or '').lower()
        return h in ('localhost', '127.0.0.1', '::1')
    except Exception:
        return ('localhost' in (url or '') or '127.0.0.1' in (url or ''))

def _dashboard_url_fallbacks(url):
    # ONLY for local dev loopback (Astro may bind IPv6 localhost only). Never mutate remote/production URLs.
    if not url:
        return []
    out = [url]
    if _is_loopback_dashboard_url(url):
        if '://127.0.0.1' in url:
            out.append(url.replace('://127.0.0.1', '://localhost'))
            out.append(url.replace('://127.0.0.1', '://[::1]'))
        elif '://localhost' in url:
            out.append(url.replace('://localhost', '://127.0.0.1'))
            out.append(url.replace('://localhost', '://[::1]'))
        elif '://[::1]' in url:
            out.append(url.replace('://[::1]', '://localhost'))
            out.append(url.replace('://[::1]', '://127.0.0.1'))
    # dedupe preserve order
    seen = set(); res = []
    for u in out:
        if u not in seen:
            seen.add(u); res.append(u)
    return res


PUPR_API_KEY_FIELDS = {
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_AI_MODEL',
}


def _mask_for_log(value):
    v = (value or '').strip()
    if not v:
        return ''
    return '*' * len(v) if len(v) <= 8 else (v[:4] + '...' + v[-4:])


def load_dashboard_pupr_keys(payload=None):
    global CLOUDFLARE_AI_RUN_URL, CLOUDFLARE_AI_FORMAT
    """Load PUPR API keys + AI config from dashboard API/DB (public.app_settings). Source of truth."""
    if payload is None:
        payload = fetch_dashboard_pupr_config()
    if not isinstance(payload, dict):
        return None
    try:
        keys = payload.get('keys')
        ai_cfg = payload.get('aiConfig')
        if isinstance(keys, dict):
            applied = []
            for k in PUPR_API_KEY_FIELDS:
                v = keys.get(k)
                if not isinstance(v, str):
                    continue
                vv = v.strip()
                if vv:
                    os.environ[k] = vv  # DB/dashboard is the source of truth for PUPR API keys
                    applied.append(k)
                elif k == 'CLOUDFLARE_AI_MODEL':
                    # keep a safe default if dashboard stores empty model
                    os.environ.setdefault(k, '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
            if applied or payload.get('ok'):
                os.environ['PUPR_KEYS_SOURCE'] = f"dashboard_db:{DASHBOARD_CONFIG_URL}"
                if applied:
                    cf = ('CLOUDFLARE_ACCOUNT_ID=' + _mask_for_log(os.environ.get('CLOUDFLARE_ACCOUNT_ID',''))) if 'CLOUDFLARE_ACCOUNT_ID' in applied else ''
                    print('[config] Loaded PUPR keys from dashboard DB:', ', '.join(sorted(applied)), flush=True)
                    if cf:
                        print('[config] DB key check:', cf, 'CLOUDFLARE_API_TOKEN=' + _mask_for_log(os.environ.get('CLOUDFLARE_API_TOKEN','')), flush=True)
                else:
                    print('[config] Dashboard DB config loaded but no API keys are set (fill in Admin > PUPR API Keys).', flush=True)
        # Dedicated Cloudflare provider table (URL + model) from dashboard DB
        cfprov = payload.get('cloudflareProvider')
        if isinstance(cfprov, dict):
            ru = str(cfprov.get('runUrl') or cfprov.get('run_url') or '').strip()
            if ru:
                CLOUDFLARE_AI_RUN_URL = ru[:500]
                os.environ['CLOUDFLARE_AI_RUN_URL'] = CLOUDFLARE_AI_RUN_URL
            rf = str(cfprov.get('requestFormat') or cfprov.get('request_format') or '').strip().lower()
            if rf in ('auto', 'messages', 'gemini_contents'):
                CLOUDFLARE_AI_FORMAT = rf
                os.environ['CLOUDFLARE_AI_FORMAT'] = rf
            cm = str(cfprov.get('model') or '').strip()
            if cm:
                os.environ['CLOUDFLARE_AI_MODEL'] = cm[:200]
            print('[config] Loaded Cloudflare provider from dashboard DB:', CLOUDFLARE_AI_RUN_URL[:80], os.environ.get('CLOUDFLARE_AI_MODEL',''), CLOUDFLARE_AI_FORMAT, flush=True)
        if isinstance(ai_cfg, dict) and apply_dashboard_ai_config(ai_cfg):
            os.environ['PUPR_AI_CONFIG_SOURCE'] = f"dashboard_db:{DASHBOARD_CONFIG_URL}"
            print('[config] Loaded PUPR AI config from dashboard DB (systemPrompt + limits)', flush=True)
        return payload
    except Exception as e:
        print('[config] Dashboard PUPR config not loaded:', repr(e), flush=True)
        return None


def deep_merge(base, override):
    if not isinstance(override, dict):
        return override if override is not None else base
    out = dict(base or {})
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            out[k] = deep_merge(base[k], v)
        else:
            out[k] = v
    return out


# Minimal fallback only when dashboard API/DB and app.config.json are unavailable.
# Runtime source of truth: dashboard API/DB (pupr.ai_config + keys) via load_dashboard_pupr_keys().
FALLBACK_APP_CONFIG = {
    'app': {'language': 'id-ID'},
    'backend': {'host': '127.0.0.1', 'port': 8767},
    'tts': {'provider': 'databyte', 'defaultSpeaker': 'brian', 'defaultVoice': 'brian', 'model': 'elevenlabs/eleven-v3-conversational', 'apiUrl': 'https://ai.databyte.co.id/gateway/v1/audio/speech'},
    'ai': {
        'systemPrompt': '',  # filled from dashboard API/DB (pupr.ai_config.systemPrompt)
        'maxHistoryMessages': 12,
        'maxTextChars': 800,
        'maxReplyChars': 1200,
        'cooldownSeconds': 2,
    },
}

FALLBACK_SYSTEM_PROMPT = (
    'Anda adalah resepsionis virtual resmi Dinas Pekerjaan Umum dan Penataan Ruang (DPU) Kabupaten Sukabumi. '
    'Layani percakapan interaktif dengan warga secara ramah, sopan, singkat, jelas, dan membantu. '
    'Jawab dalam bahasa Indonesia. Gunakan konteks percakapan sebelumnya dan, jika tersedia, "Referensi Website DPU" yang diberikan oleh sistem sebagai sumber jawaban. '
    'Jangan mengarang informasi resmi. Jika informasi tidak ada di referensi/konteks, katakan dengan jujur bahwa informasi perlu dikonfirmasi ke DPU Kabupaten Sukabumi dan arahkan ke https://dpu.sukabumikab.go.id bila relevan.'
)


DASHBOARD_BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

def _dashboard_json_headers(extra=None):
    headers = {
        'Accept': 'application/json',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'User-Agent': DASHBOARD_BROWSER_USER_AGENT,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
    }
    if extra:
        headers.update(extra)
    if DASHBOARD_CONFIG_TOKEN:
        headers['x-pupr-config-token'] = DASHBOARD_CONFIG_TOKEN
    return headers


def fetch_dashboard_pupr_config():
    """Fetch PUPR config (API keys + AI config) from dashboard API/DB."""
    if not DASHBOARD_CONFIG_URL:
        return None
    headers = _dashboard_json_headers()
    last_err = None
    for url in _dashboard_url_fallbacks(DASHBOARD_CONFIG_URL):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=DASHBOARD_CONFIG_TIMEOUT) as resp:
                payload = _json.loads(resp.read().decode('utf-8'))
            if isinstance(payload, dict):
                if url != DASHBOARD_CONFIG_URL:
                    os.environ['DASHBOARD_CONFIG_URL_EFFECTIVE'] = url
                return payload
        except HTTPError as e:
            body = ''
            try: body = e.read().decode('utf-8', errors='ignore')[:350]
            except Exception: pass
            last_err = f"HTTP {e.code} {body or getattr(e,'reason','')}".strip()
            continue
        except Exception as e:
            last_err = repr(e)
            continue
    if last_err is not None:
        error_text = str(last_err)
        if 'browser_signature_banned' in error_text or 'error 1010' in error_text.lower():
            hint = ' Cloudflare is blocking the Python HTTP client signature (1010), not the PUPR service token.'
        elif '403' in error_text or 'PUPR_CONFIG_TOKEN' in error_text or 'Unauthorized' in error_text:
            hint = ' Set matching DASHBOARD_CONFIG_TOKEN/PUPR_CONFIG_TOKEN if remote service requires it.'
        else:
            hint = ''
        print('[config] Dashboard PUPR config not loaded:', last_err, 'url=', DASHBOARD_CONFIG_URL, 'urls_tried=', _dashboard_url_fallbacks(DASHBOARD_CONFIG_URL), hint, flush=True)
    return None


def load_app_config():
    # Base fallback -> app.config.json (userData/packaged/local) -> dashboard API/DB runtime overrides happen in load_dashboard_pupr_keys/apply_dashboard_ai_config.
    cfg = _json.loads(_json.dumps(FALLBACK_APP_CONFIG))  # deep-ish copy of simple dict
    candidates = []
    if os.environ.get('APP_CONFIG_PATH'):
        candidates.append(os.environ.get('APP_CONFIG_PATH'))
    try:
        candidates.extend([str(DATA_DIR / 'app.config.json'), str(APP_ROOT / 'app.config.json')])
    except Exception:
        pass
    candidates.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app.config.json'))
    cfg_path = next((p for p in candidates if p and os.path.exists(p)), candidates[-1])
    try:
        if os.path.exists(cfg_path):
            with open(cfg_path, 'r', encoding='utf-8') as f:
                cfg = deep_merge(cfg, _json.load(f) or {})
    except Exception as e:
        print('[config] Failed to load app config:', repr(e), flush=True)
    return cfg


APP_CONFIG = load_app_config()

app = Flask(__name__)
CORS(app)
conversation_history = []
MAX_HISTORY_MESSAGES = int((APP_CONFIG.get('ai') or {}).get('maxHistoryMessages', 12))
MAX_TEXT_CHARS = int((APP_CONFIG.get('ai') or {}).get('maxTextChars', 800))
MAX_REPLY_CHARS = int((APP_CONFIG.get('ai') or {}).get('maxReplyChars', 1200))
AI_LOCK = threading.Lock()
AI_COOLDOWN_SECONDS = float((APP_CONFIG.get('ai') or {}).get('cooldownSeconds', 2))
last_ai_request_at = 0.0
SYSTEM_PROMPT = (APP_CONFIG.get('ai') or {}).get('systemPrompt') or FALLBACK_SYSTEM_PROMPT
_tts_cfg = (APP_CONFIG.get('tts') or {})
TTS_PROVIDER = str(os.environ.get('TTS_PROVIDER') or _tts_cfg.get('provider') or 'databyte').strip().lower()
DEFAULT_TTS_SPEAKER = str(os.environ.get('TTS_VOICE') or _tts_cfg.get('defaultVoice') or _tts_cfg.get('defaultSpeaker') or 'brian').strip() or 'brian'
TTS_API_URL = str(os.environ.get('TTS_API_URL') or _tts_cfg.get('apiUrl') or 'https://ai.databyte.co.id/gateway/v1/audio/speech').strip()
TTS_API_KEY = str(os.environ.get('TTS_API_KEY') or _tts_cfg.get('apiKey') or '').strip()
TTS_MODEL = str(os.environ.get('TTS_MODEL') or _tts_cfg.get('model') or 'elevenlabs/eleven-v3-conversational').strip()
TTS_TIMEOUT = float(os.environ.get('TTS_TIMEOUT') or _tts_cfg.get('timeoutSeconds') or 60)
# Cloudflare Workers AI provider (run URL + model/format) - can be overridden by dashboard DB pupr_cloudflare_provider
CLOUDFLARE_AI_RUN_URL = (os.environ.get('CLOUDFLARE_AI_RUN_URL') or 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run').strip()
CLOUDFLARE_AI_FORMAT = (os.environ.get('CLOUDFLARE_AI_FORMAT') or 'auto').strip().lower()  # auto|messages|gemini_contents
STT_LANGUAGE = (APP_CONFIG.get('app') or {}).get('language', 'id-ID')
# Website reference (RAG-lite): AI can read selected official pages as grounded context.
REFERENCE_WEBSITE_ENABLED = bool((APP_CONFIG.get('ai') or {}).get('referenceWebsiteEnabled', True))
REFERENCE_WEBSITE_URL = ((APP_CONFIG.get('ai') or {}).get('referenceWebsiteUrl') or 'https://dpu.sukabumikab.go.id').strip()
REFERENCE_WEBSITE_MAX_CHARS = int((APP_CONFIG.get('ai') or {}).get('referenceWebsiteMaxChars', 3500))
REFERENCE_WEBSITE_TTL_SECONDS = int((APP_CONFIG.get('ai') or {}).get('referenceWebsiteTtlSeconds', 900))
REFERENCE_WEBSITE_ALLOWED_HOST = 'dpu.sukabumikab.go.id'
_REFERENCE_WEB_CACHE = {}  # url -> {ts,text,err}
_REFERENCE_WEB_LOCK = threading.Lock()

def _sanitize_reference_website_url(url):
    raw = (url or '').strip()
    if not raw:
        return 'https://dpu.sukabumikab.go.id'
    try:
        u = urllib.parse.urlparse(raw)
        if u.scheme != 'https' or (u.hostname or '').lower() != REFERENCE_WEBSITE_ALLOWED_HOST:
            return 'https://dpu.sukabumikab.go.id'
        # strip fragments/credentials
        return urllib.parse.urlunparse((u.scheme, REFERENCE_WEBSITE_ALLOWED_HOST, u.path or '/', '', u.query or '', ''))
    except Exception:
        return 'https://dpu.sukabumikab.go.id'

class _HTMLTextExtractor(HTMLParser):
    _SKIP = {'script','style','noscript','header','footer','nav','svg','form','iframe'}
    def __init__(self):
        super().__init__()
        self._skip_depth = 0
        self.parts = []
        self.title = ''
        self._in_title = False
    def handle_starttag(self, tag, attrs):
        t = (tag or '').lower()
        if t in self._SKIP: self._skip_depth += 1
        if t == 'title': self._in_title = True
        if t in ('br','p','li','h1','h2','h3','h4','tr','div','section','article'): self.parts.append('\n')
    def handle_endtag(self, tag):
        t = (tag or '').lower()
        if t in self._SKIP and self._skip_depth > 0: self._skip_depth -= 1
        if t == 'title': self._in_title = False
    def handle_data(self, data):
        if not data: return
        if self._in_title and not self.title: self.title = data.strip()[:180]
        if self._skip_depth == 0: self.parts.append(data)

def _fetch_reference_page_text(url, max_chars):
    url = _sanitize_reference_website_url(url)
    now = time.time()
    ttl = max(60, int(REFERENCE_WEBSITE_TTL_SECONDS or 900))
    with _REFERENCE_WEB_LOCK:
        c = _REFERENCE_WEB_CACHE.get(url)
        if c and (now - float(c.get('ts') or 0)) < ttl and c.get('text'):
            return c.get('text'), url, False
    try:
        class _NoCrossHostRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                try:
                    u = urllib.parse.urlparse(newurl)
                    if u.scheme != 'https' or (u.hostname or '').lower() != REFERENCE_WEBSITE_ALLOWED_HOST:
                        return None
                except Exception:
                    return None
                return super().redirect_request(req, fp, code, msg, headers, newurl)
        opener = urllib.request.build_opener(_NoCrossHostRedirect)
        req = urllib.request.Request(url, headers={'Accept': 'text/html,application/xhtml+xml', 'User-Agent': 'PUPR-AI-Assistant/1.0 (+dpu.sukabumikab.go.id reference)'})
        with opener.open(req, timeout=6) as resp:
            ctype = (resp.headers.get('Content-Type') or '').lower()
            raw = resp.read(400_000)
        # decode
        text_html = raw.decode('utf-8', errors='ignore')
        parser = _HTMLTextExtractor()
        parser.feed(text_html)
        body = ' '.join(' '.join(parser.parts).split())
        title = (parser.title or '').strip()
        out = (f"Judul: {title}\n" if title else '') + body
        out = out.strip()[: max(0, int(max_chars or 0))] if max_chars else out.strip()
        with _REFERENCE_WEB_LOCK:
            _REFERENCE_WEB_CACHE[url] = {'ts': now, 'text': out}
            while len(_REFERENCE_WEB_CACHE) > 40:
                _REFERENCE_WEB_CACHE.pop(next(iter(_REFERENCE_WEB_CACHE)))
        return out, url, True
    except Exception as e:
        msg = repr(e)[:180]
        with _REFERENCE_WEB_LOCK:
            c = _REFERENCE_WEB_CACHE.get(url) or {}
            _REFERENCE_WEB_CACHE[url] = {**c, 'ts': now, 'err': msg}
        return '', url, False

def build_website_reference_context(question_text):
    if not REFERENCE_WEBSITE_ENABLED:
        return '', {}
    max_chars = max(0, int(REFERENCE_WEBSITE_MAX_CHARS or 0))
    if max_chars <= 0:
        return '', {}
    base = _sanitize_reference_website_url(REFERENCE_WEBSITE_URL)
    q = (question_text or '').lower()
    # pick a couple of likely-relevant official pages (best-effort heuristic; still grounded to same domain)
    paths = ['/', '/profil', '/layanan', '/berita', '/pengumuman', '/kontak']
    if any(k in q for k in ('kontak','alamat','telp','telepon','email','hubungi','lokasi','jam')):
        paths = ['/kontak','/profil','/','/layanan']
    elif any(k in q for k in ('berita','informasi','pengumuman','kegiatan')):
        paths = ['/berita','/pengumuman','/','/profil']
    elif any(k in q for k in ('layanan','pengaduan','izin','permohonan','prosedur','syarat')):
        paths = ['/layanan','/','/profil','/kontak']
    # de-dupe while preserving order
    seen=set(); urls=[]
    for p in paths:
        u = base.rstrip('/') + (p if p.startswith('/') else '/' + p)
        u = _sanitize_reference_website_url(u)
        if u not in seen:
            seen.add(u); urls.append(u)
        if len(urls) >= 3: break
    parts=[]; used=[]
    budget = max_chars
    for u in urls:
        if budget < 250: break
        txt, fu, fetched = _fetch_reference_page_text(u, min(1800, budget))
        if txt:
            parts.append(f"[Sumber: {fu}]\n{txt}")
            used.append(fu)
            budget -= len(parts[-1]) + 20
    if not parts:
        return '', {'enabled': True, 'base': base, 'sources': [], 'reason': 'no_content'}
    ctx = "REFERENSI WEBSITE RESMI DPU KABUPATEN SUKABUMI (gunakan sebagai acuan; jangan mengarang):\n\n" + "\n\n---\n\n".join(parts)
    return ctx[:max_chars], {'enabled': True, 'base': base, 'sources': used}

def apply_dashboard_ai_config(cfg):
    """Apply AI/config limits from dashboard DB payload (pupr.ai_config)."""
    global MAX_HISTORY_MESSAGES, MAX_TEXT_CHARS, MAX_REPLY_CHARS, AI_COOLDOWN_SECONDS, SYSTEM_PROMPT, DEFAULT_TTS_SPEAKER, STT_LANGUAGE
    global REFERENCE_WEBSITE_ENABLED, REFERENCE_WEBSITE_URL, REFERENCE_WEBSITE_MAX_CHARS, REFERENCE_WEBSITE_TTL_SECONDS
    if not isinstance(cfg, dict):
        return False
    try:
        if 'maxHistoryMessages' in cfg: MAX_HISTORY_MESSAGES = max(0, min(50, int(cfg['maxHistoryMessages'])))
        if 'maxTextChars' in cfg: MAX_TEXT_CHARS = max(50, min(8000, int(cfg['maxTextChars'])))
        if 'maxReplyChars' in cfg: MAX_REPLY_CHARS = max(50, min(8000, int(cfg['maxReplyChars'])))
        if 'cooldownSeconds' in cfg: AI_COOLDOWN_SECONDS = max(0.0, min(60.0, float(cfg['cooldownSeconds'])))
        sp = cfg.get('systemPrompt')
        if isinstance(sp, str) and sp.strip():
            SYSTEM_PROMPT = sp.strip()[:12000]
        stt = cfg.get('sttLanguage')
        if isinstance(stt, str) and stt.strip():
            STT_LANGUAGE = stt.strip()[:32]
        spk = cfg.get('ttsDefaultSpeaker') or cfg.get('ttsVoice') or cfg.get('defaultVoice')
        if isinstance(spk, str) and spk.strip():
            DEFAULT_TTS_SPEAKER = spk.strip()[:64]
        if isinstance(cfg.get('ttsModel'), str) and cfg.get('ttsModel').strip():
            globals()['TTS_MODEL'] = cfg.get('ttsModel').strip()[:120]
        if isinstance(cfg.get('ttsApiUrl'), str) and cfg.get('ttsApiUrl').strip():
            globals()['TTS_API_URL'] = cfg.get('ttsApiUrl').strip()[:500]
        # ttsApiKey from dashboard is optional; env .env takes precedence in practice
        if isinstance(cfg.get('ttsApiKey'), str) and cfg.get('ttsApiKey').strip() and not os.environ.get('TTS_API_KEY'):
            globals()['TTS_API_KEY'] = cfg.get('ttsApiKey').strip()
        if 'referenceWebsiteEnabled' in cfg: REFERENCE_WEBSITE_ENABLED = bool(cfg.get('referenceWebsiteEnabled'))
        if 'referenceWebsiteUrl' in cfg: REFERENCE_WEBSITE_URL = _sanitize_reference_website_url(cfg.get('referenceWebsiteUrl'))
        if 'referenceWebsiteMaxChars' in cfg: REFERENCE_WEBSITE_MAX_CHARS = max(0, min(12000, int(cfg.get('referenceWebsiteMaxChars') or 0)))
        if 'referenceWebsiteTtlSeconds' in cfg: REFERENCE_WEBSITE_TTL_SECONDS = max(60, min(86400, int(cfg.get('referenceWebsiteTtlSeconds') or 900)))
        # Trim existing history to new limit
        if MAX_HISTORY_MESSAGES > 0:
            del conversation_history[:-MAX_HISTORY_MESSAGES]
        else:
            conversation_history.clear()
        return True
    except Exception as e:
        print('[config] Failed to apply dashboard AI config:', repr(e), flush=True)
        return False


# Simple local in-memory cache for repeated questions (saves tokens; DB cache is persisted via dashboard)
CONVERSATION_CACHE = {}
CONVERSATION_CACHE_MAX = int(os.environ.get('CONVERSATION_CACHE_MAX', '300'))


def _normalize_question(text):
    # Keep normalization logic aligned with dashboard/src/lib/puprConversationCache.ts
    try:
        import re
        t = str(text or '').lower()
        t = t.replace('\u2018', "'").replace('\u2019', "'").replace('`', "'")
        # drop punctuation incl '?' for stable cache keys (matches dashboard)
        t = re.sub(r"[^\w\s]", " ", t, flags=re.UNICODE)
        t = re.sub(r"\s+", " ", t).strip()
        return t
    except Exception:
        return ' '.join(str(text or '').lower().split()).strip()


def _cache_put(norm, payload):
    if not norm or not payload:
        return
    CONVERSATION_CACHE[norm] = payload
    # simple size bound (FIFO-ish by insertion order in modern Python dict)
    while len(CONVERSATION_CACHE) > CONVERSATION_CACHE_MAX:
        try:
            CONVERSATION_CACHE.pop(next(iter(CONVERSATION_CACHE)))
        except Exception:
            break


def _dashboard_post_json(url, payload):
    if not url:
        return None
    headers = _dashboard_json_headers({'Content-Type': 'application/json'})
    last_err = None
    for u in _dashboard_url_fallbacks(url):
        try:
            req = urllib.request.Request(u, data=_json.dumps(payload).encode('utf-8'), headers=headers, method='POST')
            with urllib.request.urlopen(req, timeout=DASHBOARD_CONFIG_TIMEOUT) as resp:
                out = _json.loads(resp.read().decode('utf-8'))
            if isinstance(out, dict):
                return out
        except Exception as e:
            last_err = e
            continue
    if last_err is not None:
        print('[conversation-cache] dashboard call failed:', repr(last_err), flush=True)
    return None


def lookup_cached_answer(question_text):
    norm = _normalize_question(question_text)
    if not norm or len(norm) < 3:
        return None
    local = CONVERSATION_CACHE.get(norm)
    if local and local.get('answer'):
        return {**local, 'source': 'local_memory', 'normalized': norm}
    # Ask dashboard DB cache (authoritative; supports fuzzy token fallback there)
    for q in [question_text, norm]:
        out = _dashboard_post_json(os.environ.get('DASHBOARD_CONVERSATION_URL_EFFECTIVE') or DASHBOARD_CONVERSATION_URL, {'action': 'lookup', 'question': q})
        if isinstance(out, dict) and out.get('ok') and out.get('hit') and isinstance(out.get('cache'), dict):
            cache = out['cache']
            answer = (cache.get('answer_text') or '').strip()
            if answer:
                payload = {'answer': answer, 'provider': cache.get('provider') or 'cache', 'model': cache.get('model') or '', 'id': cache.get('id')}
                _cache_put(norm, payload)
                return {**payload, 'source': 'dashboard_db', 'normalized': norm}
    return None


def store_cached_answer(question_text, answer_text='', provider=None, model=None, metadata=None, status=None, unanswered=False):
    norm = _normalize_question(question_text)
    if not norm or len(norm) < 3:
        return
    answer_clean = (answer_text or '').strip()
    if answer_clean:
        payload = {'answer': answer_clean, 'provider': provider or '', 'model': model or ''}
        _cache_put(norm, payload)
    _dashboard_post_json(os.environ.get('DASHBOARD_CONVERSATION_URL_EFFECTIVE') or DASHBOARD_CONVERSATION_URL, {
        'action': 'store',
        'question': question_text,
        'answer': answer_text or '',
        'provider': provider or '',
        'model': model or '',
        'status': status or '',
        'markUnanswered': bool(unanswered),
        'metadata': metadata or {},
    })


# Load AI prompt/batasan + API keys from dashboard DB API (source of truth; overrides app.config.json defaults when available)
load_dashboard_pupr_keys()


def sanitize_text(value):
    if not isinstance(value, str):
        return ''
    return ' '.join(value.replace('\x00', '').split())[:MAX_TEXT_CHARS]


def prepare_tts_text(value):
    text = sanitize_text(value)
    replacements = {
        'PUPR': 'P U P R',
        'PU': 'P U',
        'AI': 'A I',
        'KTP': 'K T P',
        'Jl.': 'Jalan ',
        'No.': 'Nomor ',
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    text = text.replace(':', ', ').replace(';', ', ')
    text = text.replace('!', '! ')
    text = text.replace('?', '? ')
    text = text.replace('.', '. ')
    return ' '.join(text.split())[:MAX_TEXT_CHARS]


def remember_message(role, content):
    content = sanitize_text(content)
    if not content:
        return
    conversation_history.append({'role': role, 'content': content})
    del conversation_history[:-MAX_HISTORY_MESSAGES]


def estimate_tokens(text):
    # Fallback only when provider usage is unavailable (rough approximation).
    text = text or ''
    if not text:
        return 0
    return max(1, int((len(text) / 4) + 0.999))


def report_token_usage(provider, model=None, prompt_text='', response_text='', success=True, error_message='', usage=None, endpoint='/ai', metadata=None):
    usage = usage if isinstance(usage, dict) else {}
    prompt_tokens = int(usage.get('prompt_tokens') or 0)
    completion_tokens = int(usage.get('completion_tokens') or usage.get('output_tokens') or 0)
    total_tokens = int(usage.get('total_tokens') or 0)
    if prompt_tokens <= 0 and prompt_text:
        prompt_tokens = estimate_tokens(prompt_text)
    if completion_tokens <= 0 and response_text:
        completion_tokens = estimate_tokens(response_text)
    if total_tokens <= 0:
        total_tokens = prompt_tokens + completion_tokens
    payload = {
        'provider': provider,
        'model': model or '',
        'endpoint': endpoint,
        'prompt_tokens': prompt_tokens,
        'completion_tokens': completion_tokens,
        'total_tokens': total_tokens,
        'success': bool(success),
        'error_message': (error_message or '')[:500],
        'request_chars': len(prompt_text or ''),
        'response_chars': len(response_text or ''),
        'metadata': metadata or {},
    }
    base_url = os.environ.get('DASHBOARD_USAGE_URL_EFFECTIVE') or DASHBOARD_USAGE_URL
    if not base_url:
        return
    headers = _dashboard_json_headers({'Content-Type': 'application/json'})
    last_err = None
    for url in _dashboard_url_fallbacks(base_url):
        try:
            req = urllib.request.Request(
                url,
                data=_json.dumps(payload).encode('utf-8'),
                headers=headers,
                method='POST',
            )
            with urllib.request.urlopen(req, timeout=DASHBOARD_CONFIG_TIMEOUT) as resp:
                resp.read()
            if url != base_url:
                os.environ['DASHBOARD_USAGE_URL_EFFECTIVE'] = url
            return
        except Exception as e:
            last_err = e
            continue
    if last_err is not None:
        print('[usage] Failed to report token usage:', repr(last_err), flush=True)

@app.route('/stt', methods=['POST'])
def stt():
    if 'audio' not in request.files:
        return jsonify({'error': 'no audio'}), 400
    f = request.files['audio']
    tmp_path = None
    try:
        # Close the temp handle before Werkzeug writes to the same path (Windows file locking).
        with tempfile.NamedTemporaryFile(delete=False, suffix='.wav') as tmp:
            tmp_path = tmp.name
        f.save(tmp_path)
        r = sr.Recognizer()
        with sr.AudioFile(tmp_path) as source:
            audio = r.record(source)
        print('sample_rate:', audio.sample_rate, 'sample_width:', audio.sample_width, 'frames:', len(audio.frame_data), flush=True)
        if not audio.frame_data or len(audio.frame_data) < audio.sample_rate * audio.sample_width // 2:
            return jsonify({'text': ''})
        text = r.recognize_google(audio, language=STT_LANGUAGE)
        print('result:', repr(text), flush=True)
        return jsonify({'text': text})
    except sr.UnknownValueError:
        print('[stt] speech not recognized in this recording', flush=True)
        return jsonify({'text': ''})
    except Exception as e:
        import traceback; traceback.print_exc()
        print('[stt] failed:', repr(e), flush=True)
        return jsonify({'error': f'Pengenalan suara gagal: {e}'}), 502
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except Exception:
                pass

from flask import send_file, Response

BASE_DIR = APP_ROOT
# Writable cache (packaged apps often cannot write to bundled resources/Program Files)
_tts_cache_env = (os.environ.get('TTS_CACHE_DIR') or '').strip()
try:
    TTS_CACHE_DIR = Path(_tts_cache_env) if _tts_cache_env else (DATA_DIR / '.tts-cache')
    TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    TTS_CACHE_DIR = Path(tempfile.gettempdir()) / 'pupr-tts-cache'
    TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
# legacy local Coqui markers (compat)
MODEL_PATH = os.environ.get('TTS_MODEL_PATH', '')
CONFIG_PATH = os.environ.get('TTS_CONFIG_PATH', '')
TTS_READY = bool(TTS_API_URL and TTS_API_KEY)

def _redact_tts_key(url):
    try:
        u = urllib.parse.urlparse(url or '')
        return f"{u.scheme}://{u.netloc}{u.path}" if u.netloc else (url or '')
    except Exception:
        return ''

@app.route('/tts', methods=['POST'])
def tts():
    data = request.get_json(force=True) or {}
    text = sanitize_text(data.get('text', ''))[:MAX_TEXT_CHARS]
    voice = str((data.get('voice') or data.get('speaker') or DEFAULT_TTS_SPEAKER or 'brian')).strip() or 'brian'
    model = str((data.get('model') or TTS_MODEL or 'elevenlabs/eleven-v3-conversational')).strip()
    if not text:
        return jsonify({'error': 'no text'}), 400
    if not TTS_API_URL or not TTS_API_KEY:
        return jsonify({'error': 'TTS remote gateway belum dikonfigurasi (TTS_API_URL/TTS_API_KEY).'}), 503

    cache_key = hashlib.sha256(f'databyte:{model}:{voice}:{text}'.encode('utf-8')).hexdigest()
    cache_path = TTS_CACHE_DIR / f'{cache_key}.mp3'
    if cache_path.exists() and cache_path.stat().st_size > 0:
        return send_file(cache_path, mimetype='audio/mpeg', as_attachment=False, download_name='response.mp3')

    payload = _json.dumps({'model': model, 'input': text, 'voice': voice}).encode('utf-8')
    req = urllib.request.Request(
        TTS_API_URL,
        data=payload,
        headers={
            'Authorization': 'Bearer ' + TTS_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg,*/*;q=0.8',
            'User-Agent': 'PUPR-Backend/1.0 (+local)',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=max(5, float(TTS_TIMEOUT or 60))) as resp:
            ctype = (resp.headers.get('Content-Type') or '').lower()
            audio_bytes = resp.read()
        if not audio_bytes:
            return jsonify({'error': 'TTS gateway mengembalikan audio kosong'}), 502
        if 'json' in ctype or (audio_bytes[:1] == b'{' and b'"' in audio_bytes[:80]):
            try:
                detail = audio_bytes.decode('utf-8', errors='ignore')[:1200]
            except Exception:
                detail = '<non-audio response>'
            print('[tts] gateway non-audio response', {'voice': voice, 'model': model, 'ctype': ctype, 'url': _redact_tts_key(TTS_API_URL)}, flush=True)
            return jsonify({'error': 'TTS gateway returned non-audio response', 'detail': detail, 'voice': voice, 'model': model}), 502
        try:
            cache_path.write_bytes(audio_bytes)
        except Exception:
            pass
        mimetype = 'audio/mpeg' if ('mpeg' in ctype or 'mp3' in ctype) else (ctype.split(';')[0].strip() or 'audio/mpeg')
        return Response(audio_bytes, mimetype=mimetype, headers={'Content-Disposition': 'inline; filename="response.mp3"'})
    except HTTPError as e:
        err_body = ''
        try:
            err_body = e.read().decode('utf-8', errors='ignore')[:1600]
        except Exception:
            pass
        is_cloudflare_block = ('cloudflare' in (err_body or '').lower() and e.code == 403) or ('access denied' in (err_body or '').lower() and e.code == 403)
        hint = (
            'DataByte gateway diblokir Cloudflare/WAF (403 Access denied) untuk request dari server ini. '
            'Backend sudah set User-Agent/Accept eksplisit; jika masih 403, kemungkinan IP/rule WAF atau izin API key/project TTS. '
            'Cek whitelist IP backend & API key DataByte, lalu restart backend PUPR.'
        ) if is_cloudflare_block else (
            'Periksa TTS_API_KEY, model, dan voice untuk gateway DataByte (401/403).'
        ) if e.code in (401, 403) else None
        print('[tts] gateway HTTP error', {'voice': voice, 'model': model, 'status': e.code, 'url': _redact_tts_key(TTS_API_URL), 'cloudflare_block': is_cloudflare_block, 'detail_preview': (err_body or '')[:180]}, flush=True)
        status = 502 if e.code >= 500 else (503 if e.code in (401, 403) else 502)
        out = {'error': 'TTS gateway request failed', 'detail': err_body or str(e), 'http_status': e.code, 'voice': voice, 'model': model}
        if hint: out['hint'] = hint
        return jsonify(out), status
    except (URLError, Exception) as e:
        print('[tts] gateway exception', {'voice': voice, 'model': model, 'err': repr(e)}, flush=True)
        return jsonify({'error': 'TTS gateway request failed', 'detail': repr(e)[:800], 'voice': voice, 'model': model}), 502

def mask_secret(value):
    value = (value or '').strip()
    if not value:
        return ''
    if len(value) <= 8:
        return '*' * len(value)
    return value[:4] + '…' + value[-4:]


def _is_loopback_request():
    try:
        ip = (request.remote_addr or '').strip()
        host = (request.host or '').split(':', 1)[0].strip().lower()
        return ip in ('127.0.0.1', '::1', '::ffff:127.0.0.1') and host in ('127.0.0.1', 'localhost', '[::1]', '::1')
    except Exception:
        return False


@app.before_request
def _guard_local_api_routes():
    # Defense-in-depth: backend binds loopback, but block non-loopback callers if misconfigured/proxied.
    if request.path in ('/api-status', '/api-config') and not _is_loopback_request():
        return jsonify({'error': 'Forbidden'}), 403


@app.route('/api-status', methods=['GET'])
def api_status():
    # Local-only debug/status endpoint (no secret values returned).
    return jsonify({
        'ok': True,
        'keys_source': os.environ.get('PUPR_KEYS_SOURCE') or '',
        'ai_config_source': os.environ.get('PUPR_AI_CONFIG_SOURCE') or '',
        'dashboard_config_url': DASHBOARD_CONFIG_URL,
        'dashboard_usage_url': DASHBOARD_USAGE_URL,
        'dashboard_conversation_url': DASHBOARD_CONVERSATION_URL,
        'conversation_cache_local_entries': len(CONVERSATION_CACHE),
        'providers': {
            'cloudflare': bool(os.environ.get('CLOUDFLARE_ACCOUNT_ID') and os.environ.get('CLOUDFLARE_API_TOKEN')),
            'gemini': bool(os.environ.get('GEMINI_API_KEY')),
            'openai': bool(os.environ.get('OPENAI_API_KEY')),
        },
        'cloudflare_model': os.environ.get('CLOUDFLARE_AI_MODEL', ''),
        'limits': {
            'maxHistoryMessages': MAX_HISTORY_MESSAGES,
            'maxTextChars': MAX_TEXT_CHARS,
            'maxReplyChars': MAX_REPLY_CHARS,
            'cooldownSeconds': AI_COOLDOWN_SECONDS,
            'sttLanguage': STT_LANGUAGE,
            'ttsDefaultSpeaker': DEFAULT_TTS_SPEAKER,
            'ttsProvider': TTS_PROVIDER,
            'ttsModel': TTS_MODEL,
            'ttsApiUrl': _redact_tts_key(TTS_API_URL),
            'ttsApiKeyConfigured': bool(TTS_API_KEY),
            'systemPromptChars': len(SYSTEM_PROMPT or ''),
        },
        'masks': {
            'CLOUDFLARE_ACCOUNT_ID': mask_secret(os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')),
            'CLOUDFLARE_API_TOKEN': mask_secret(os.environ.get('CLOUDFLARE_API_TOKEN', '')),
            'GEMINI_API_KEY': mask_secret(os.environ.get('GEMINI_API_KEY', '')),
            'OPENAI_API_KEY': mask_secret(os.environ.get('OPENAI_API_KEY', '')),
        }
    })


@app.route('/api-config', methods=['GET'])
def api_config():
    # Expose effective runtime config loaded from dashboard API/DB (no secrets). Useful for UI/display/debug.
    return jsonify({
        'ok': True,
        'source': os.environ.get('PUPR_AI_CONFIG_SOURCE') or 'app_config_or_default',
        'dashboard_config_url': DASHBOARD_CONFIG_URL,
        'ai': {
            'systemPrompt': SYSTEM_PROMPT,
            'maxHistoryMessages': MAX_HISTORY_MESSAGES,
            'maxTextChars': MAX_TEXT_CHARS,
            'maxReplyChars': MAX_REPLY_CHARS,
            'cooldownSeconds': AI_COOLDOWN_SECONDS,
        },
        'app': {'language': STT_LANGUAGE},
        'tts': {'defaultSpeaker': DEFAULT_TTS_SPEAKER, 'provider': TTS_PROVIDER, 'model': TTS_MODEL, 'apiUrl': _redact_tts_key(TTS_API_URL), 'apiKeyConfigured': bool(TTS_API_KEY)},
        'backend': {'host': os.environ.get('BACKEND_HOST') or (APP_CONFIG.get('backend') or {}).get('host') or '127.0.0.1', 'port': int(os.environ.get('BACKEND_PORT') or (APP_CONFIG.get('backend') or {}).get('port') or 8767)},
    })


@app.route('/ai', methods=['POST'])
def ai():
    if not request.is_json:
        return jsonify({'error': 'AI hanya menerima JSON berisi text'}), 415
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or set(data) != {'text'}:
        return jsonify({'error': 'Payload AI harus tepat berisi field text'}), 400
    text = sanitize_text(data.get('text'))
    if not text:
        return jsonify({'error': 'text wajib berupa string yang tidak kosong'}), 400
    # Lazy reload: API keys/config come from dashboard DB at startup; if dashboard started later, retry once.
    # Also retry if no AI provider key is currently available (handles dashboard restart / DB update cases).
    has_any_provider = bool(
        (os.environ.get('CLOUDFLARE_ACCOUNT_ID') and os.environ.get('CLOUDFLARE_API_TOKEN'))
        or os.environ.get('GEMINI_API_KEY')
        or os.environ.get('OPENAI_API_KEY')
    )
    if not os.environ.get('PUPR_KEYS_SOURCE') or not has_any_provider:
        try:
            load_dashboard_pupr_keys()
        except Exception:
            pass
    global last_ai_request_at
    if not AI_LOCK.acquire(blocking=False):
        return jsonify({'error': 'Permintaan AI masih diproses, tunggu sebentar.'}), 429
    now = time.monotonic()
    wait = AI_COOLDOWN_SECONDS - (now - last_ai_request_at)
    if wait > 0:
        AI_LOCK.release()
        return jsonify({'error': 'AI sedang cooldown, coba lagi sebentar.'}), 429
    last_ai_request_at = now
    remember_message('user', text)

    # Cache hit: reuse saved Q&A answer without calling AI provider (saves tokens).
    # Stored in dashboard DB (pupr_conversation_cache) + local in-memory mirror.
    cached = lookup_cached_answer(text)
    if cached and cached.get('answer'):
        reply = sanitize_text(cached['answer'])[:MAX_REPLY_CHARS]
        remember_message('assistant', reply)
        report_token_usage(
            'cache',
            model=cached.get('model') or 'conversation_cache',
            prompt_text=text,
            response_text=reply,
            success=True,
            usage={'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0},
            metadata={'source': cached.get('source') or 'cache', 'cache_hit': True, 'saved_tokens_est': estimate_tokens(text) + estimate_tokens(reply)},
        )
        AI_LOCK.release()
        return jsonify({'text': reply, 'provider': 'cache', 'cached': True, 'cache_source': cached.get('source')})

    # Grounded reference from official website (best-effort; same domain only). Not cached as Q&A.
    ref_ctx, ref_meta = ('', {})
    try:
        ref_ctx, ref_meta = build_website_reference_context(text)
    except Exception as _re:
        print('[ref-web] failed:', repr(_re), flush=True)

    # Prefer Cloudflare Workers AI when both credentials are configured.
    cf_account = (os.environ.get('CLOUDFLARE_ACCOUNT_ID', '') or '').strip()
    cf_token = (os.environ.get('CLOUDFLARE_API_TOKEN', '') or '').strip()
    if cf_account and cf_token:
        cf_model = (os.environ.get('CLOUDFLARE_AI_MODEL', '@cf/meta/llama-3.3-70b-instruct-fp8-fast') or '@cf/meta/llama-3.3-70b-instruct-fp8-fast').strip()
        try:
            cf_account.encode('ascii'); cf_model.encode('ascii')
        except Exception:
            report_token_usage('cloudflare', model=cf_model, prompt_text=text, response_text='', success=False, error_message='invalid_cloudflare_identifier_format')
            AI_LOCK.release()
            return jsonify({'error': 'Konfigurasi Cloudflare di database tidak valid (Account ID/Model). Perbaiki di Admin > PUPR AI Settings/API Keys lalu restart/coba lagi.', 'provider': 'cloudflare'}), 400

        run_tmpl = (CLOUDFLARE_AI_RUN_URL or os.environ.get('CLOUDFLARE_AI_RUN_URL') or 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run').strip()
        cf_url = run_tmpl.replace('{account_id}', cf_account).replace('{account}', cf_account).replace('$CLOUDFLARE_ACCOUNT_ID', cf_account).rstrip('/')
        fmt = (CLOUDFLARE_AI_FORMAT or os.environ.get('CLOUDFLARE_AI_FORMAT') or 'auto').strip().lower()
        use_gemini_contents = (fmt == 'gemini_contents') or (fmt == 'auto' and ('/google/' in (cf_model + cf_url) or cf_model.startswith('google/') or 'gemini' in cf_model.lower()))
        # Match user curl: base .../ai/run with {"model":..., "input":{"contents"...}} (model in body).
        # Legacy Workers AI chat models commonly use .../ai/run/{model} with {"messages"...} (no model in body).
        if use_gemini_contents:
            if cf_url.endswith('/ai/run/' + cf_model) or cf_url.endswith('/' + cf_model):
                cf_url = cf_url[: -len('/' + cf_model)].rstrip('/') or cf_url
            prompt_text = (SYSTEM_PROMPT + ("\n\n" + ref_ctx if ref_ctx else "") + "\n\nPertanyaan warga:\n" + text).strip()
            cf_payload_obj = {"model": cf_model, "input": {"contents": [{"parts": [{"text": prompt_text}], "role": "user"}]}}
        else:
            if cf_url.endswith('/ai/run'):
                cf_url = cf_url + '/' + cf_model
            cf_messages = [{'role': 'system', 'content': SYSTEM_PROMPT}]
            if ref_ctx: cf_messages.append({'role': 'system', 'content': ref_ctx})
            cf_messages.extend(conversation_history)
            cf_payload_obj = {'messages': cf_messages}

        cf_req = urllib.request.Request(cf_url, data=_json.dumps(cf_payload_obj).encode('utf-8'), headers={'Authorization': 'Bearer ' + cf_token, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(cf_req, timeout=60) as resp:
                cf_out = _json.loads(resp.read().decode('utf-8'))
            cf_result = cf_out.get('result', cf_out) if isinstance(cf_out, dict) else {}
            cf_reply = ''
            if isinstance(cf_result, dict):
                cf_reply = sanitize_text(cf_result.get('response') or cf_result.get('text') or cf_result.get('choices', [{}])[0].get('message', {}).get('content', ''))[:MAX_REPLY_CHARS]
            # Gemini/Google-style responses
            if not cf_reply and isinstance(cf_out, dict):
                try:
                    cands = ((cf_out.get('result') or cf_out).get('candidates') or cf_out.get('candidates') or [])
                    if cands:
                        parts = (((cands[0] or {}).get('content') or {}).get('parts') or [])
                        cf_reply = sanitize_text(''.join([str(p.get('text','')) for p in parts if isinstance(p, dict)]))[:MAX_REPLY_CHARS]
                except Exception:
                    pass
            if not cf_reply and isinstance(cf_out, dict):
                cf_reply = sanitize_text((cf_out.get('response') or ''))[:MAX_REPLY_CHARS]
            if not cf_reply:
                raise ValueError('Cloudflare mengembalikan respons kosong')
            remember_message('assistant', cf_reply)
            cf_usage = (cf_out.get('usage') or (cf_out.get('result') or {}).get('usage') or {}) if isinstance(cf_out, dict) else {}
            report_token_usage('cloudflare', model=cf_model, prompt_text=text, response_text=cf_reply, success=True, usage=cf_usage, metadata={'source': 'cloudflare_workers_ai', 'format': 'gemini_contents' if use_gemini_contents else 'messages', 'run_url': cf_url, 'ref_sources': (ref_meta or {}).get('sources', [])})
            store_cached_answer(text, cf_reply, provider='cloudflare', model=cf_model)
            AI_LOCK.release()
            return jsonify({'text': cf_reply, 'provider': 'cloudflare', 'referenceSources': (ref_meta or {}).get('sources', [])})
        except HTTPError as e:
            err_body = ''
            try: err_body = e.read().decode('utf-8', errors='ignore')[:400]
            except Exception: pass
            print('Cloudflare error:', repr(e), err_body[:120], flush=True)
            report_token_usage('cloudflare', model=cf_model, prompt_text=text, response_text='', success=False, error_message=f'HTTP {e.code} {err_body}', metadata={'http_status': e.code, 'run_url': cf_url, 'format': 'gemini_contents' if use_gemini_contents else 'messages'})
            if e.code == 429:
                AI_LOCK.release(); return jsonify({'error': 'Cloudflare mencapai batas RPM/quota. Tunggu sebentar sebelum bertanya lagi.'}), 429
        except Exception as e:
            print('Cloudflare error:', repr(e), flush=True)
            report_token_usage('cloudflare', model=cf_model, prompt_text=text, response_text='', success=False, error_message=str(e), metadata={'run_url': cf_url, 'format': 'gemini_contents' if use_gemini_contents else 'messages'})
        # Don't mark unanswered for infra/provider failures; keep user-facing response clean (frontend will skip TTS).
        try:
            report_token_usage('cloudflare', model=cf_model, prompt_text=text, response_text='', success=False, error_message='provider_error_no_tts')
        except Exception:
            pass

    # Fallback Gemini if key present
    gkey = os.environ.get('GEMINI_API_KEY', '')
    if gkey:
        gemini_model = 'gemini-2.5-flash'
        url = f'https://generativelanguage.googleapis.com/v1beta/models/{gemini_model}:generateContent?key=' + gkey
        contents = []
        for message in conversation_history:
            contents.append({'role': 'user' if message['role'] == 'user' else 'model', 'parts': [{'text': message['content']}]})
        gemini_system = SYSTEM_PROMPT + ("\n\n" + ref_ctx if ref_ctx else "")
        payload = _json.dumps({
            'system_instruction': {'parts': [{'text': gemini_system}]},
            'contents': contents
        }).encode('utf-8')
        req = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                out = _json.loads(resp.read().decode('utf-8'))
            reply = sanitize_text(out['candidates'][0]['content']['parts'][0]['text'])[:MAX_REPLY_CHARS]
            remember_message('model', reply)
            usage_meta = out.get('usageMetadata') or {}
            gemini_usage = {
                'prompt_tokens': int(usage_meta.get('promptTokenCount') or 0),
                'completion_tokens': int(usage_meta.get('candidatesTokenCount') or 0),
                'total_tokens': int(usage_meta.get('totalTokenCount') or 0),
            }
            report_token_usage('gemini', model=gemini_model, prompt_text=text, response_text=reply, success=True, usage=gemini_usage, metadata={'source': 'gemini_generate_content', 'ref_sources': (ref_meta or {}).get('sources', [])})
            store_cached_answer(text, reply, provider='gemini', model=gemini_model)
            AI_LOCK.release()
            return jsonify({'text': reply, 'provider': 'gemini', 'referenceSources': (ref_meta or {}).get('sources', [])})
        except HTTPError as e:
            err_body = ''
            try:
                err_body = e.read().decode('utf-8', errors='ignore')[:300]
            except Exception:
                pass
            print('Gemini error:', repr(e), flush=True)
            report_token_usage('gemini', model=gemini_model, prompt_text=text, response_text='', success=False, error_message=f'HTTP {e.code} {err_body}', metadata={'http_status': e.code})
            if e.code == 429:
                AI_LOCK.release()
                return jsonify({'error': 'Gemini mencapai batas RPM/quota. Tunggu sebentar sebelum bertanya lagi.'}), 429
        except Exception as e:
            print('Gemini error:', repr(e), flush=True)
            report_token_usage('gemini', model=gemini_model, prompt_text=text, response_text='', success=False, error_message=str(e))
            # Continue to OpenAI fallback below.
        store_cached_answer(text, '', provider='gemini', model=gemini_model, unanswered=True, metadata={'reason': 'provider_error'})
    # Fallback OpenAI
    okey = os.environ.get('OPENAI_API_KEY', '')
    if not okey:
        report_token_usage('none', model='', prompt_text=text, response_text='', success=False, error_message='no_api_key_configured', metadata={'keys_source': os.environ.get('PUPR_KEYS_SOURCE') or '', 'ai_config_source': os.environ.get('PUPR_AI_CONFIG_SOURCE') or '', 'dashboard_config_url': DASHBOARD_CONFIG_URL})
        store_cached_answer(text, '', provider='none', model='', unanswered=True, metadata={'reason': 'no_api_key_configured'})
        AI_LOCK.release()
        return jsonify({
            'error': 'API key AI belum tersedia. Pastikan dashboard berjalan (default http://127.0.0.1:4321), key sudah disimpan di Admin > PUPR API Keys (DB), lalu restart/coba lagi.',
            'detail': {
                'keys_source': os.environ.get('PUPR_KEYS_SOURCE') or '',
                'ai_config_source': os.environ.get('PUPR_AI_CONFIG_SOURCE') or '',
                'dashboard_config_url': DASHBOARD_CONFIG_URL,
            }
        }), 400
    openai_model = 'gpt-4o-mini'
    oai_messages = [{'role': 'system', 'content': SYSTEM_PROMPT}]
    if ref_ctx:
        oai_messages.append({'role': 'system', 'content': ref_ctx})
    oai_messages.extend(conversation_history)
    payload = _json.dumps({
        'model': openai_model,
        'messages': oai_messages
    }).encode('utf-8')
    req = urllib.request.Request(
        'https://api.openai.com/v1/chat/completions',
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + okey
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            out = _json.loads(resp.read().decode('utf-8'))
        reply = sanitize_text(out['choices'][0]['message']['content'])[:MAX_REPLY_CHARS]
        remember_message('assistant', reply)
        report_token_usage('openai', model=openai_model, prompt_text=text, response_text=reply, success=True, usage=out.get('usage') or {}, metadata={'source': 'openai_chat_completions', 'ref_sources': (ref_meta or {}).get('sources', [])})
        store_cached_answer(text, reply, provider='openai', model=openai_model)
        AI_LOCK.release()
        return jsonify({'text': reply, 'provider': 'openai', 'referenceSources': (ref_meta or {}).get('sources', [])})
    except HTTPError as e:
        err_body = ''
        try:
            err_body = e.read().decode('utf-8', errors='ignore')[:300]
        except Exception:
            pass
        print('OpenAI error:', repr(e), flush=True)
        report_token_usage('openai', model=openai_model, prompt_text=text, response_text='', success=False, error_message=f'HTTP {e.code} {err_body}', metadata={'http_status': e.code})
        store_cached_answer(text, '', provider='openai', model=openai_model, unanswered=True, metadata={'reason': f'http_{e.code}'})
        AI_LOCK.release()
        return jsonify({
            'error': 'AI sedang tidak tersedia. Periksa quota/rate limit Gemini atau OpenAI.',
            'detail': f'HTTP {e.code}'
        }), 503
    except Exception as e:
        print('OpenAI error:', repr(e), flush=True)
        report_token_usage('openai', model=openai_model, prompt_text=text, response_text='', success=False, error_message=str(e))
        store_cached_answer(text, '', provider='openai', model=openai_model, unanswered=True, metadata={'reason': 'provider_error'})
        AI_LOCK.release()
        return jsonify({
            'error': 'AI sedang tidak tersedia. Periksa quota/rate limit Gemini atau OpenAI.',
            'detail': str(e)
        }), 503

if __name__ == '__main__':
    host = os.environ.get('BACKEND_HOST') or (APP_CONFIG.get('backend') or {}).get('host') or '127.0.0.1'
    try:
        port = int(os.environ.get('BACKEND_PORT') or (APP_CONFIG.get('backend') or {}).get('port') or 8767)
    except Exception:
        port = 8767
    try:
        from waitress import serve
    except ImportError:
        print('[server] Waitress is not installed; using Flask server. Install tts/requirements.txt for production WSGI.', flush=True)
        app.run(host=host, port=port, debug=False)
    else:
        print(f'[server] Starting production WSGI server at http://{host}:{port}', flush=True)
        serve(app, host=host, port=port)

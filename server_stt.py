import os
import tempfile
import hashlib
import json as _json
import threading
import time
import urllib.request
from urllib.error import HTTPError
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
BASE_DIR_PATH = Path(__file__).resolve().parent
load_env_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'), override=False)

# Load PUPR API keys from Dashboard DB (preferred source). Dashboard stores them in public.app_settings.
DASHBOARD_CONFIG_URL = os.environ.get('DASHBOARD_CONFIG_URL', 'http://localhost:4321/api/pupr/config')
DASHBOARD_USAGE_URL = os.environ.get('DASHBOARD_USAGE_URL', '')
if not DASHBOARD_USAGE_URL and DASHBOARD_CONFIG_URL.endswith('/api/pupr/config'):
    DASHBOARD_USAGE_URL = DASHBOARD_CONFIG_URL[:-len('/api/pupr/config')] + '/api/pupr/usage'
elif not DASHBOARD_USAGE_URL:
    DASHBOARD_USAGE_URL = 'http://localhost:4321/api/pupr/usage'
DASHBOARD_CONVERSATION_URL = os.environ.get('DASHBOARD_CONVERSATION_URL', '')
if not DASHBOARD_CONVERSATION_URL and DASHBOARD_CONFIG_URL.endswith('/api/pupr/config'):
    DASHBOARD_CONVERSATION_URL = DASHBOARD_CONFIG_URL[:-len('/api/pupr/config')] + '/api/pupr/conversation'
elif not DASHBOARD_CONVERSATION_URL:
    DASHBOARD_CONVERSATION_URL = 'http://localhost:4321/api/pupr/conversation'
DASHBOARD_CONFIG_TOKEN = os.environ.get('DASHBOARD_CONFIG_TOKEN') or os.environ.get('PUPR_CONFIG_TOKEN') or ''
DASHBOARD_CONFIG_TIMEOUT = float(os.environ.get('DASHBOARD_CONFIG_TIMEOUT', '2.5'))


def _dashboard_url_fallbacks(url):
    # Astro dev on macOS may bind IPv6 localhost only; try localhost/127.0.0.1/[::1] variants.
    if not url:
        return []
    out = [url]
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
    return '*' * len(v) if len(v) <= 8 else (v[:4] + '…' + v[-4:])


def load_dashboard_pupr_keys(payload=None):
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
    'tts': {'defaultSpeaker': 'wibowo'},
    'ai': {
        'systemPrompt': '',  # filled from dashboard API/DB (pupr.ai_config.systemPrompt)
        'maxHistoryMessages': 12,
        'maxTextChars': 800,
        'maxReplyChars': 1200,
        'cooldownSeconds': 2,
    },
}

FALLBACK_SYSTEM_PROMPT = (
    'Anda adalah resepsionis virtual resmi Dinas Pekerjaan Umum (PU) Kabupaten Sukabumi. '
    'Layani percakapan interaktif dengan warga secara ramah, sopan, singkat, jelas, dan membantu. '
    'Jawab dalam bahasa Indonesia. Gunakan konteks percakapan sebelumnya, jawab pertanyaan lanjutan secara natural, '
    'dan jangan mengarang informasi resmi. Jika informasi tidak tersedia, katakan bahwa informasi perlu dikonfirmasi kepada Dinas PU Kabupaten Sukabumi.'
)


def fetch_dashboard_pupr_config():
    """Fetch PUPR config (API keys + AI config) from dashboard API/DB."""
    if not DASHBOARD_CONFIG_URL:
        return None
    headers = {'Accept': 'application/json'}
    if DASHBOARD_CONFIG_TOKEN:
        headers['x-pupr-config-token'] = DASHBOARD_CONFIG_TOKEN
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
        except Exception as e:
            last_err = e
            continue
    if last_err is not None:
        print('[config] Dashboard PUPR config not loaded:', repr(last_err), 'urls=', _dashboard_url_fallbacks(DASHBOARD_CONFIG_URL), flush=True)
    return None


def load_app_config():
    # Base fallback -> local app.config.json (compat) -> dashboard API/DB runtime overrides happen in load_dashboard_pupr_keys/apply_dashboard_ai_config.
    cfg = _json.loads(_json.dumps(FALLBACK_APP_CONFIG))  # deep-ish copy of simple dict
    cfg_path = os.environ.get('APP_CONFIG_PATH') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app.config.json')
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
DEFAULT_TTS_SPEAKER = (APP_CONFIG.get('tts') or {}).get('defaultSpeaker', 'wibowo')
STT_LANGUAGE = (APP_CONFIG.get('app') or {}).get('language', 'id-ID')

def apply_dashboard_ai_config(cfg):
    """Apply AI/config limits from dashboard DB payload (pupr.ai_config)."""
    global MAX_HISTORY_MESSAGES, MAX_TEXT_CHARS, MAX_REPLY_CHARS, AI_COOLDOWN_SECONDS, SYSTEM_PROMPT, DEFAULT_TTS_SPEAKER, STT_LANGUAGE
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
        spk = cfg.get('ttsDefaultSpeaker')
        if isinstance(spk, str) and spk.strip():
            DEFAULT_TTS_SPEAKER = spk.strip()[:64]
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
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if DASHBOARD_CONFIG_TOKEN:
        headers['x-pupr-config-token'] = DASHBOARD_CONFIG_TOKEN
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
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if DASHBOARD_CONFIG_TOKEN:
        headers['x-pupr-config-token'] = DASHBOARD_CONFIG_TOKEN
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
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.wav')
    f.save(tmp.name)
    tmp.close()
    try:
        r = sr.Recognizer()
        with sr.AudioFile(tmp.name) as source:
            audio = r.record(source)
        print('sample_rate:', audio.sample_rate, 'sample_width:', audio.sample_width, 'frames:', len(audio.frame_data), flush=True)
        if not audio.frame_data or len(audio.frame_data) < audio.sample_rate * audio.sample_width // 2:
            return jsonify({'text': ''})
        text = r.recognize_google(audio, language=STT_LANGUAGE)
        print('result:', repr(text), flush=True)
        return jsonify({'text': text})
    except sr.UnknownValueError:
        return jsonify({'text': ''})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500
    finally:
        try:
            os.remove(tmp.name)
        except Exception:
            pass

import subprocess
import sys
from flask import send_file

BASE_DIR = BASE_DIR_PATH
MODEL_PATH = os.environ.get('TTS_MODEL_PATH', str(Path.home() / 'Library/Caches/g2p_id/checkpoint_1260000-inference.pth'))
_CONFIG_CANDIDATES = [
    os.environ.get('TTS_CONFIG_PATH', ''),
    str(BASE_DIR / 'tts-config.json'),
    '/private/tmp/scratchpad/TTS-Indonesia-Gratis/config.json',
]
CONFIG_PATH = next((p for p in _CONFIG_CANDIDATES if p and Path(p).exists()), _CONFIG_CANDIDATES[1])
TTS_COMMAND = os.environ.get('TTS_COMMAND', str(Path(sys.executable).parent / 'tts'))
if not Path(TTS_COMMAND).exists():
    TTS_COMMAND = os.environ.get('TTS_COMMAND', 'tts')
TTS_CACHE_DIR = BASE_DIR / '.tts-cache'
TTS_CACHE_DIR.mkdir(exist_ok=True)
TTS_READY = Path(MODEL_PATH).exists() and Path(CONFIG_PATH).exists()

@app.route('/tts', methods=['POST'])
def tts():
    data = request.get_json(force=True) or {}
    text = prepare_tts_text(data.get('text', ''))
    speaker = data.get('speaker') or DEFAULT_TTS_SPEAKER
    if not text:
        return jsonify({'error': 'no text'}), 400
    if not TTS_READY:
        return jsonify({'error': 'TTS model/config tidak ditemukan'}), 503
    cache_key = hashlib.sha256(f'{speaker}:{text}'.encode('utf-8')).hexdigest()
    cache_path = TTS_CACHE_DIR / f'{cache_key}.wav'
    if cache_path.exists():
        return send_file(cache_path, mimetype='audio/wav', as_attachment=False)
    try:
        subprocess.run([
            TTS_COMMAND, '--text', text, '--model_path', MODEL_PATH,
            '--config_path', CONFIG_PATH, '--speaker_idx', speaker,
            '--out_path', str(cache_path)
        ], check=True, capture_output=True, text=True, timeout=120)
        return send_file(cache_path, mimetype='audio/wav', as_attachment=False)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        # keep file for send_file; cleanup after response not handled here (temp)
        pass

def mask_secret(value):
    value = (value or '').strip()
    if not value:
        return ''
    if len(value) <= 8:
        return '*' * len(value)
    return value[:4] + '…' + value[-4:]


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
        'tts': {'defaultSpeaker': DEFAULT_TTS_SPEAKER},
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

    # Prefer Cloudflare Workers AI when both credentials are configured.
    cf_account = (os.environ.get('CLOUDFLARE_ACCOUNT_ID', '') or '').strip()
    cf_token = (os.environ.get('CLOUDFLARE_API_TOKEN', '') or '').strip()
    if cf_account and cf_token:
        cf_model = (os.environ.get('CLOUDFLARE_AI_MODEL', '@cf/meta/llama-3.3-70b-instruct-fp8-fast') or '@cf/meta/llama-3.3-70b-instruct-fp8-fast').strip()
        # Defensive: reject corrupted/non-ASCII identifiers (prevents urllib http.client UnicodeEncodeError)
        try:
            cf_account.encode('ascii')
            cf_model.encode('ascii')
        except Exception:
            report_token_usage('cloudflare', model=cf_model, prompt_text=text, response_text='', success=False, error_message='invalid_cloudflare_identifier_format')
            AI_LOCK.release()
            return jsonify({'error': 'Konfigurasi Cloudflare di database tidak valid (Account ID/Model mengandung karakter tidak valid). Buka Dashboard Admin > PUPR API Keys, perbaiki Cloudflare Account ID dan Model, simpan, lalu restart/coba lagi.', 'provider': 'cloudflare'}), 400
        cf_url = f'https://api.cloudflare.com/client/v4/accounts/{cf_account}/ai/run/{cf_model}'
        cf_messages = [{'role': 'system', 'content': SYSTEM_PROMPT}]
        cf_messages.extend(conversation_history)
        cf_payload = _json.dumps({'messages': cf_messages}).encode('utf-8')
        cf_req = urllib.request.Request(
            cf_url,
            data=cf_payload,
            headers={
                'Authorization': 'Bearer ' + cf_token,
                'Content-Type': 'application/json'
            }
        )
        try:
            with urllib.request.urlopen(cf_req, timeout=60) as resp:
                cf_out = _json.loads(resp.read().decode('utf-8'))
            cf_result = cf_out.get('result', cf_out)
            cf_reply = sanitize_text(
                cf_result.get('response')
                or cf_result.get('text')
                or cf_result.get('choices', [{}])[0].get('message', {}).get('content', '')
            )[:MAX_REPLY_CHARS]
            if not cf_reply:
                raise ValueError('Cloudflare mengembalikan respons kosong')
            remember_message('assistant', cf_reply)
            cf_usage = {}
            if isinstance(cf_out, dict):
                cf_usage = cf_out.get('usage') or (cf_out.get('result') or {}).get('usage') or {}
            report_token_usage('cloudflare', model=cf_model, prompt_text=text, response_text=cf_reply, success=True, usage=cf_usage, metadata={'source': 'cloudflare_workers_ai'})
            store_cached_answer(text, cf_reply, provider='cloudflare', model=cf_model)  # dashboard detects unanswered phrases
            AI_LOCK.release()
            return jsonify({'text': cf_reply, 'provider': 'cloudflare'})
        except HTTPError as e:
            err_body = ''
            try:
                err_body = e.read().decode('utf-8', errors='ignore')[:300]
            except Exception:
                pass
            print('Cloudflare error:', repr(e), flush=True)
            report_token_usage('cloudflare', model=cf_model, prompt_text=text, response_text='', success=False, error_message=f'HTTP {e.code} {err_body}', metadata={'http_status': e.code})
            if e.code == 429:
                AI_LOCK.release()
                return jsonify({'error': 'Cloudflare mencapai batas RPM/quota. Tunggu sebentar sebelum bertanya lagi.'}), 429
        except Exception as e:
            print('Cloudflare error:', repr(e), flush=True)
            report_token_usage('cloudflare', model=cf_model, prompt_text=text, response_text='', success=False, error_message=str(e))
        # Cloudflare failed; flag question for admin review (keeps DB record of unanswered attempt)
        store_cached_answer(text, '', provider='cloudflare', model=cf_model, unanswered=True, metadata={'reason': 'provider_error'})

    # Fallback Gemini if key present
    gkey = os.environ.get('GEMINI_API_KEY', '')
    if gkey:
        gemini_model = 'gemini-2.5-flash'
        url = f'https://generativelanguage.googleapis.com/v1beta/models/{gemini_model}:generateContent?key=' + gkey
        contents = []
        for message in conversation_history:
            contents.append({'role': 'user' if message['role'] == 'user' else 'model', 'parts': [{'text': message['content']}]})
        payload = _json.dumps({
            'system_instruction': {'parts': [{'text': SYSTEM_PROMPT}]},
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
            report_token_usage('gemini', model=gemini_model, prompt_text=text, response_text=reply, success=True, usage=gemini_usage, metadata={'source': 'gemini_generate_content'})
            store_cached_answer(text, reply, provider='gemini', model=gemini_model)
            AI_LOCK.release()
            return jsonify({'text': reply, 'provider': 'gemini'})
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
    payload = _json.dumps({
        'model': openai_model,
        'messages': [{'role': 'system', 'content': SYSTEM_PROMPT}, *conversation_history]
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
        report_token_usage('openai', model=openai_model, prompt_text=text, response_text=reply, success=True, usage=out.get('usage') or {}, metadata={'source': 'openai_chat_completions'})
        store_cached_answer(text, reply, provider='openai', model=openai_model)
        AI_LOCK.release()
        return jsonify({'text': reply, 'provider': 'openai'})
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
    app.run(host=host, port=port, debug=False)

import os
import tempfile
import hashlib
import json as _json
import threading
import time
import urllib.request
from urllib.error import HTTPError
import speech_recognition as sr
from flask import Flask, request, jsonify
from flask_cors import CORS

# Load .env
_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
if os.path.exists(_env_path):
    with open(_env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

app = Flask(__name__)
CORS(app)
conversation_history = []
MAX_HISTORY_MESSAGES = 12
MAX_TEXT_CHARS = 800
MAX_REPLY_CHARS = 1200
AI_LOCK = threading.Lock()
AI_COOLDOWN_SECONDS = 2
last_ai_request_at = 0.0
SYSTEM_PROMPT = (
    'Anda adalah resepsionis virtual resmi Dinas Pekerjaan Umum (PU) Kabupaten Sukabumi. '
    'Layani percakapan interaktif dengan warga secara ramah, sopan, singkat, jelas, dan membantu. '
    'Jawab dalam bahasa Indonesia. Gunakan konteks percakapan sebelumnya, jawab pertanyaan lanjutan secara natural, '
    'dan jangan mengarang informasi resmi. Jika informasi tidak tersedia, katakan bahwa informasi perlu dikonfirmasi kepada Dinas PU Kabupaten Sukabumi.'
)


def sanitize_text(value):
    if not isinstance(value, str):
        return ''
    return ' '.join(value.replace('\x00', '').split())[:MAX_TEXT_CHARS]


def remember_message(role, content):
    content = sanitize_text(content)
    if not content:
        return
    conversation_history.append({'role': role, 'content': content})
    del conversation_history[:-MAX_HISTORY_MESSAGES]

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
        text = r.recognize_google(audio, language='id-ID')
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
from pathlib import Path
from flask import send_file

BASE_DIR = Path(__file__).resolve().parent
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
    text = data.get('text', '')
    speaker = data.get('speaker', 'wibowo')
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
    # Prefer Cloudflare Workers AI when both credentials are configured.
    cf_account = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
    cf_token = os.environ.get('CLOUDFLARE_API_TOKEN', '')
    if cf_account and cf_token:
        cf_model = os.environ.get('CLOUDFLARE_AI_MODEL', '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
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
            AI_LOCK.release()
            return jsonify({'text': cf_reply, 'provider': 'cloudflare'})
        except HTTPError as e:
            print('Cloudflare error:', repr(e), flush=True)
            if e.code == 429:
                AI_LOCK.release()
                return jsonify({'error': 'Cloudflare mencapai batas RPM/quota. Tunggu sebentar sebelum bertanya lagi.'}), 429
        except Exception as e:
            print('Cloudflare error:', repr(e), flush=True)

    # Fallback Gemini if key present
    gkey = os.environ.get('GEMINI_API_KEY', '')
    if gkey:
        url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + gkey
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
            AI_LOCK.release()
            return jsonify({'text': reply})
        except HTTPError as e:
            print('Gemini error:', repr(e), flush=True)
            if e.code == 429:
                AI_LOCK.release()
                return jsonify({'error': 'Gemini mencapai batas RPM/quota. Tunggu sebentar sebelum bertanya lagi.'}), 429
        except Exception as e:
            print('Gemini error:', repr(e), flush=True)
            # Continue to OpenAI fallback below.
    # Fallback OpenAI
    okey = os.environ.get('OPENAI_API_KEY', '')
    if not okey:
        AI_LOCK.release()
        return jsonify({'error': 'no api key'}), 400
    payload = _json.dumps({
        'model': 'gpt-4o-mini',
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
        AI_LOCK.release()
        return jsonify({'text': reply})
    except Exception as e:
        print('OpenAI error:', repr(e), flush=True)
        AI_LOCK.release()
        return jsonify({
            'error': 'AI sedang tidak tersedia. Periksa quota/rate limit Gemini atau OpenAI.',
            'detail': str(e)
        }), 503

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8767, debug=False)

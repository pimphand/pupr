# PUPR TTS / Backend (Python)

Folder ini berisi aplikasi Python terpisah (backend STT/TTS/AI) yang dipakai oleh aplikasi Electron.

## Isi utama
- `server_stt.py` — server Flask (`/tts`, `/stt`, `/ai`, dll.)
- `requirements.txt` — dependensi Python
- `.env.example` — contoh konfigurasi environment (jangan commit `.env` berisi secret)
- `tts.txt` — catatan TTS
- (opsional, hasil build) `server_stt.exe` — backend ter-bundle via PyInstaller

## Menjalankan (development)
```bash
cd tts
pip install -r requirements.txt
python server_stt.py
```

## Build executable (opsional, bundling ke Electron)
Dari root project:
```bash
npm run build:backend
```
`npm run build:backend` (script `scripts/build-backend.js`) mencari `tts/server_stt.py` dan menaruh hasil build di folder `tts/` (mis. `server_stt.exe` di Windows) jika PyInstaller tersedia.

## Catatan
- Konfigurasi/secret (mis. `TTS_API_KEY`, provider AI) sebaiknya via `.env`/user config/data dir atau Dashboard DB — jangan hardcode/bundle secret.
- Cache/audio runtime disimpan di data dir user (bukan folder instalasi) oleh `server_stt.py`.

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

## Menjalankan dengan Docker
```bash
cd tts
cp .env.example .env   # opsional: isi TTS_API_KEY / DASHBOARD_CONFIG_URL
# DASHBOARD_CONFIG_URL di Docker: http://host.docker.internal:4321/api/pupr/config
docker compose up -d --build
curl http://127.0.0.1:8767/api-status
```
- Port publish default `127.0.0.1:8767` (ubah lewat `TTS_PORT`/`TTS_BIND`), sama dengan `backend.baseUrl` di `app.config.json`.
- Cache MP3 + `.env` user disimpan di volume `tts_data` (`/data`), bukan di image.
- `.env` tidak ikut ke image (lihat `.dockerignore`); nilainya di-inject lewat `env_file`/`environment` compose.
- `PUPR_ALLOW_REMOTE_API=1` di compose diperlukan agar `/api-status` & `/api-config` bisa dibaca app dari host (default-nya hanya loopback).
- Supaya Electron memakai container ini dan tidak spawn Python lokal: set `TTS_URL=http://127.0.0.1:8767` dan `PUPR_BACKEND_AUTOSTART=false` di `../.env`.

## Build executable (opsional, bundling ke Electron)
Dari root project:
```bash
npm run build:backend
```
`npm run build:backend` (script `scripts/build-backend.js`) mencari `tts/server_stt.py` dan menaruh hasil build di folder `tts/` (mis. `server_stt.exe` di Windows) jika PyInstaller tersedia.

## Catatan
- Konfigurasi/secret (mis. `TTS_API_KEY`, provider AI) sebaiknya via `.env`/user config/data dir atau Dashboard DB — jangan hardcode/bundle secret.
- Cache/audio runtime disimpan di data dir user (bukan folder instalasi) oleh `server_stt.py`.

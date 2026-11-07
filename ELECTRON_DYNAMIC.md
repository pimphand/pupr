# Electron Dynamic Configuration (PUPR)

Perubahan ini membuat app Electron `pupr/` lebih dinamis dengan konfigurasi terpusat di `app.config.json`.

## File konfigurasi

- `pupr/app.config.json` — konfigurasi utama (app, backend, TTS/STT/AI, avatar, fitur).
- `pupr/.env` — kredensial/API key backend Python (tetap terpisah dari config UI/fitur).

## Apa yang sekarang dinamis

### 1. Main process Electron (`main.js`)
- Ukuran window, title, permission handler, dan user-agent dibaca dari `app.config.json`.
- Backend Python bisa diaktif/nonaktifkan, host/port/script bisa diubah (`backend.*`).
- `APP_CONFIG_PATH` diteruskan ke proses Python.

### 2. Python backend (`server_stt.py`)
- Membaca `app.config.json` (via `APP_CONFIG_PATH` atau file lokal).
- Host/port (`backend.host`, `backend.port`, atau env `BACKEND_HOST/BACKEND_PORT`).
- Bahasa STT (`app.language`).
- Prompt AI, batas history/teks, cooldown (`ai.*`).
- Default speaker TTS (`tts.defaultSpeaker`).

### 3. Renderer/frontend
- `src/appConfig.js` memuat `/app.config.json` saat boot dan menyediakan fallback default.
- `src/main.js` memakai config untuk:
  - base URL backend (`/stt`, `/ai`),
  - bahasa/speaker/rate/pitch/volume TTS,
  - greeting awal, branding/title/footer/panel debug,
  - retry STT (`silenceMs`, `maxNetworkRetries`, `retryDelayMs`),
  - toggle fitur (`features.aiEnabled`, `features.recordAfterSpeak`, dll).
- `src/voice/speechSynthesis.js` mendukung `configureSpeechSynthesis(...)` (base URL backend TTS, speaker default, backend-first toggle, rate/pitch/volume/lang).
- `src/avatar/hologramScene.js` menerima opsi avatar dinamis:
  - `avatar.backgroundPath`
  - `avatar.videos.standby`
  - `avatar.videos.speaking`
  - `avatar.imageWidth`, `avatar.fitScale`, `avatar.positionStorageKey`

## Contoh pengaturan cepat

Ubah `pupr/app.config.json`:

- Ganti identitas organisasi/greeting:
  - `app.name`, `app.organization`, `app.greeting`
- Ganti backend:
  - `backend.host`, `backend.port`, `backend.baseUrl`, `backend.enabled`
- Ganti karakter/avatar:
  - `avatar.backgroundPath`, `avatar.videos.standby`, `avatar.videos.speaking`
- Ganti perilaku suara:
  - `tts.defaultSpeaker`, `tts.rate`, `tts.backendFirst`
  - `stt.silenceMs`, `stt.maxNetworkRetries`

## Catatan

- Setelah mengubah config, restart app Electron (`npm start` / jalankan ulang) agar main process & backend membaca perubahan.
- `speechSynthesis.js` masih punya default fallback URL/speaker agar modul tetap aman jika dipakai terpisah; runtime utama mengambil nilai dari `app.config.json`.
- `node --check` pada file ESM frontend tanpa konteks module bisa error sintaks `import`; validasi yang relevan untuk app ini adalah menjalankan Electron/Vite/runtime browser module. `server_stt.py` sudah lolos compile check (`python3 -m py_compile`).

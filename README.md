# Resepsionis Virtual PUPR — Holographic Echo System

Aplikasi Electron/renderer simulasi resepsionis virtual hologram Dinas PUPR. Karakter hologram mendengarkan ucapan pengguna, mengirimnya ke backend lokal (STT/AI/TTS opsional), lalu merespons dengan suara.

## Perubahan Dinamis (baru)

Konfigurasi utama sekarang dipusatkan di **`app.config.json`** (di root `pupr/`) agar mudah diubah tanpa hardcode.

- `main.js` (Electron): window, permission, user-agent, start backend Python.
- `server_stt.py` (Flask backend): host/port, bahasa STT, prompt AI, batas/cooldown, speaker TTS default.
- `src/main.js` (renderer): base URL backend, greeting/branding, bahasa, perilaku STT/TTS/AI, toggle fitur.
- `src/voice/speechSynthesis.js`: konfigurasi backend TTS, speaker, rate/pitch/volume, backend-first.
- `src/avatar/hologramScene.js`: background/video avatar, ukuran/posisi, storage key posisi.

Detail: lihat `ELECTRON_DYNAMIC.md`.

## Struktur proyek (ringkas)

```text
pupr/
├── app.config.json         # konfigurasi dinamis utama
├── index.html
├── main.js                 # Electron main process
├── preload.js
├── server_stt.py           # backend lokal STT/TTS/AI
├── package.json
├── ELECTRON_DYNAMIC.md
├── src/
│   ├── appConfig.js        # loader config frontend
│   ├── main.js             # renderer logic
│   ├── style.css
│   ├── avatar/hologramScene.js
│   ├── voice/speechRecognition.js
│   ├── voice/speechSynthesis.js
│   └── ui/controls.js
└── public/
```

## Instalasi dependensi

```bash
cd /Users/admin/Project/Dinas/pupr
npm install
```

Backend Python (opsional tapi direkomendasikan untuk STT/AI/TTS lokal): siapkan environment Python dan dependency yang dipakai `server_stt.py` (mis. `flask`, `flask-cors`, `SpeechRecognition`), plus `.env` untuk API key/provider AI bila digunakan.

## Menjalankan (Electron)

```bash
npm start
```

Electron akan memuat app via server statis lokal internal dan (secara default) mencoba menjalankan `server_stt.py` sesuai `app.config.json`.

## Konfigurasi cepat (`app.config.json`)

Contoh hal yang bisa diubah:
- `app.name`, `app.organization`, `app.greeting`, `app.language`
- `backend.enabled`, `backend.host`, `backend.port`, `backend.baseUrl`
- `avatar.backgroundPath`, `avatar.videos.standby`, `avatar.videos.speaking`
- `tts.defaultSpeaker`, `tts.rate`, `tts.backendFirst`
- `stt.silenceMs`, `stt.maxNetworkRetries`
- `features.aiEnabled`, `features.recordAfterSpeak`, `features.showDebugPanels`

> Setelah mengubah config/backend, restart aplikasi Electron.

## Catatan & troubleshooting

- Mikrofon memerlukan izin OS/browser runtime Electron.
- SpeechRecognition browser/layanan tertentu bisa butuh koneksi internet.
- Jika backend Python tidak jalan, fitur STT/AI/TTS backend bisa gagal; TTS akan fallback ke browser TTS bila tersedia.
- `speechSynthesis.js` tetap punya default fallback (untuk pemakaian modul terpisah), tapi runtime utama membaca nilai dari `app.config.json`.
# Build EXE (Windows) — Resepsionis Virtual PUPR

Build ini **tidak bergantung pada file lokal dev** (path Homebrew/macOS, dashboard `localhost` dev, atau `.env` lokal yang di-bundle). Konfigurasi runtime dibaca dari **user data** dan/atau **Dashboard API/DB** (jika dikonfigurasi).

## Arsitektur penting (harus dipahami)
- Electron (UI) + static server lokal: **dibundle** di EXE/installer.
- `server_stt.py` (Flask: `/ai`, `/tts` remote DataByte, `/stt`): **tidak otomatis jalan** di Windows target kecuali Anda menyertakan runtime Python/deps atau membundle backend sebagai executable.
  - Saat packaged, Electron akan mencari backend ter-bundle (`server_stt.exe` / `backend.exe` di resources) **atau** menjalankan `python` + `server_stt.py` jika Python tersedia di mesin target.
  - Untuk distribusi yang benar-benar mandiri: build backend Python (mis. PyInstaller) menjadi `server_stt.exe` dan letakkan di `extraResources`/`backend` (atau sesuaikan `main.js`).

## Prasyarat build
- Node.js 18+ dan npm/pnpm
- Windows (untuk hasil NSIS `.exe` yang native paling aman) **atau** build cross-platform sesuai kebijakan electron-builder (code signing opsional)

```bash
cd pupr
npm install
# build:win otomatis menjalankan build:backend (PyInstaller) jika tersedia,
# sehingga server_stt.exe ter-bundle dan client tidak perlu install Python.
npm run build:win
```
Output: `dist-electron/`.

## Konfigurasi di mesin Windows (tanpa edit file build)
Saat berjalan, aplikasi membuat folder data user (writable), mis.:
- `%APPDATA%\ResepsionisVirtualPUPR\` (Windows)

Letakkan override di sana:
- `app.config.json` — override UI/backend config (mis. `backend.baseUrl`, `backend.dashboardConfigUrl` ke dashboard produksi, bukan localhost).
- `.env` — fallback env backend **hanya untuk deployment terkontrol** (jangan ship secret di installer). Disarankan simpan kredensial di **Dashboard DB** (`app_settings`/API keys/TTS provider) dan set `DASHBOARD_CONFIG_URL`/`DASHBOARD_CONFIG_TOKEN` (jika dipakai) di config/env user data.

Cache TTS (MP3) disimpan di user data (`.tts-cache`), bukan di folder instalasi.

## Yang sengaja TIDAK di-bundle (keamanan/portabilitas)
- `.env`, `*.wav`/cache besar, `speakers.pth` (model lokal lama), `node_modules`, `dist-electron`
- Path lokal macOS/Homebrew dan default dashboard `localhost` **tidak dipaksa** saat `sys.frozen`/packaged.

## Catatan Windows/compat
- Electron main: path berbasis `process.resourcesPath`/`app.getPath('userData')`, kill backend via `taskkill` di Windows.
- `server_stt.py`: path user-data writable, tidak default ke `localhost` dashboard saat frozen, `BACKEND_HOST/PORT` env didukung.
- Pastikan firewall/antivirus mengizinkan loopback `127.0.0.1` untuk UI↔backend lokal.

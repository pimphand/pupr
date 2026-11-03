# Progress — Resepsionis Virtual PUPR (Electron)

## Overview
Electron desktop app (Mac/Windows) yang menampilkan karakter video (greenscreen) di atas background lobi PUPR, dengan STT (Python backend) + TTS (Wibowo, laki-laki) + percakapan interaktif AI (OpenAI/Gemini) dan video switching standby↔speaking.

## Architecture
- `main.js` (Electron main): spawn Python backend (`server_stt.py`), serve app via localhost HTTP (agar SpeechRecognition bisa jalan, walau tidak dipakai), grant mic permission, user agent Chrome.
- `index.html`: background.png + avatarCanvas + chat bubbles (appBubble/userBubble) + tombol Mulai. UI panel tersembunyi (display:none) tapi DOM tetap untuk main.js.
- `src/main.js`: state machine (IDLE/LISTENING/PROCESSING/SPEAKING/ERROR), HologramScene avatar, STT recording (MediaRecorder/AudioContext WAV) → backend, AI ask → TTS.
- `src/avatar/hologramScene.js`: Three.js scene, background plane, character video mesh dengan chroma key (green) shader, crossfade 2 detik antar video, drag.
- `src/voice/speechSynthesis.js`: TTS via backend (Wibowo) dengan fallback browser TTS.
- `server_stt.py`: Flask backend (port 8767) — `/stt`, `/tts`, `/ai`. Auto-start oleh Electron.

## Files & Key Points
- `public/karakter_baru/stanby.mp4` — video standby (idle).
- `public/video.mp4` — video speaking.
- `public/background.png` — latar.
- `.env` — CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (Cloudflare prioritas), GEMINI_API_KEY dan OPENAI_API_KEY sebagai fallback.
- Model TTS: `~/Library/Caches/g2p_id/checkpoint_1260000-inference.pth` + config `/private/tmp/scratchpad/TTS-Indonesia-Gratis/config.json`.
- `tts` CLI (Coqui) dipakai via subprocess untuk sintesis Wibowo.

## Flow
1. App start → standby video, diam (tidak bicara).
2. Klik "Mulai" → speakEcho("selamat datang...") [Wibowo] → video speaking → onEnd → standby.
3. startRecordingFlow: rekam audio (AudioContext) sampai 2.5s silence (min 1.5s rekaman, max 5 menit) → tampil durasi live di bubble.
4. Kirim WAV ke /stt → transkripsi Google → bubble user.
5. Kirim teks ke `/ai` → Gemini jika `GEMINI_API_KEY` tersedia, else OpenAI.
6. Backend menyimpan riwayat percakapan hingga 20 pesan dan mengirimkannya pada setiap request, sehingga Gemini dapat memahami pertanyaan lanjutan.
7. Jawaban ditampilkan di bubble app + speakEcho (Wibowo) → video speaking → selesai → video standby.
8. Setelah jawaban selesai, aplikasi otomatis kembali mendengarkan pertanyaan berikutnya untuk dialog interaktif berkelanjutan.

## VAD
- Threshold RMS 0.03, silence 2.5s, min recording 1.5s, max 300s.

## Crossfade
- 2 detik opacity transition antar video via overlay mesh (ShaderMaterial chroma key).

## Current Status (selesai)
- STT backend berjalan (Python 3.9, SpeechRecognition + flac arm64).
- TTS Wibowo via backend (Python subprocess `tts` CLI).
- AI percakapan multi-turn via backend `/ai` (Cloudflare Workers AI `ai/run` + Llama prioritas, Gemini kedua, OpenAI fallback).
- Persona AI: resepsionis resmi Dinas Pekerjaan Umum (PU) Kabupaten Sukabumi.
- Gemini menerima system prompt resepsionis PU + riwayat maksimal 20 pesan.
- Setelah TTS jawaban selesai, video kembali standby dan STT otomatis mendengarkan giliran berikutnya.
- Greenscreen chroma key (green) diterapkan.
- Bubble ganda draggable.
- No auto-listen (STT browser dimatikan untuk hindari error network).

## Known Limitations
- Path model/config TTS hardcoded (Mac). Untuk Windows perlu penyesuaian/bundling.
- STT menggunakan Google (butuh internet). Untuk offline, ganti ke whisper/vosk.
- TTS Wibowo butuh `tts` CLI (Coqui) + model ~346MB.
- Live transcription (interim) belum ada; hanya durasi rekaman ditampilkan.

## Run
- `npm start` (Electron). Backend auto-spawn. Set GEMINI_API_KEY/OPENAI_API_KEY di `.env`.
# Resepsionis Virtual PUPR — Holographic Echo System

Aplikasi web simulasi resepsionis virtual hologram Dinas PUPR. Karakter hologram mendengarkan ucapan pengguna (bahasa Indonesia) lalu mengucapkan ulang kalimat yang sama (Echo Mode).

## Struktur proyek

```
pupr/
├── index.html
├── package.json
├── vite.config.js (opsional)
├── src/
│   ├── main.js
│   ├── style.css
│   ├── avatar/hologramScene.js
│   ├── voice/speechRecognition.js
│   ├── voice/speechSynthesis.js
│   └── ui/controls.js
└── public/
```

## Instalasi dependensi

```bash
cd /Users/admin/Project/pupr
npm install
```

(Jika devDependencies tidak terpasang, jalankan `npm install --include=dev`.)

## Menjalankan (Vite)

```bash
npm run dev
```
Buka URL yang ditampilkan (biasanya `http://localhost:5173`) di Google Chrome.

Alternatif tanpa Vite (butuh server statis):
```bash
python3 -m http.server 8000
# buka http://localhost:8000
```

## Mengizinkan mikrofon

Saat menekan "Mulai Bicara", browser meminta izin mikrofon → klik "Izinkan". Jika ditolak, buka ikon gembok di address bar → izinkan mikrofon → refresh.

## Cara menguji alur

1. Buka halaman, pastikan karakter hologram tampil.
2. Klik "Mulai Bicara", izinkan mikrofon.
3. Ucapkan kalimat, misal: "Selamat pagi, saya ingin menanyakan kondisi jalan di wilayah saya."
4. Teks muncul di panel "Teks Ucapan Pengguna".
5. Karakter mengucapkan ulang kalimat tersebut (panel "Teks Ucapan Hologram").
6. Animasi mulut aktif saat berbicara.
7. Setelah selesai, kembali mendengarkan (jika auto-listen aktif).
8. Uji "Berhenti" dan "Ulangi Suara". Gunakan "Echo Teks" jika STT tidak berfungsi.

## Keterbatasan

- SpeechRecognition (Chrome) memerlukan koneksi internet (layanan Google).
- Suara Indonesia (id-ID) tidak selalu tersedia; jika tidak ada, fallback ke suara lain dengan pemberitahuan.
- Karakter dibuat prosedural (hologram cyan) tanpa ketergantungan file GLB.
- Tidak semua browser mendukung Web Speech API (gunakan Chrome/Edge).

## Pemecahan masalah

- Mikrofon tidak berfungsi: pastikan localhost/HTTPS, izin diberikan.
- SpeechRecognition error 'network': periksa koneksi internet, firewall/VPN, gunakan localhost.
- Tidak ada suara Indonesia: pilih suara lain; pemberitahuan muncul.
- Karakter tidak tampil: jalankan via `npm run dev` atau server statis.
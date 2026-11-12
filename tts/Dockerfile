# syntax=docker/dockerfile:1

# Backend STT/TTS/AI PUPR (server_stt.py) sebagai container.
# Waitserver produksi (waitress) sudah ada di requirements.txt, jadi image tinggal menjalankan
# `python server_stt.py` (script memakai waitress bila tersedia).
FROM python:3.11-slim

# BACKEND_HOST harus 0.0.0.0 di dalam container; port host diatur docker-compose (default
# 127.0.0.1:8767). PUPR_USER_DATA/TTS_CACHE_DIR menaruh cache MP3 + .env user di volume, bukan di image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    BACKEND_HOST=0.0.0.0 \
    BACKEND_PORT=8767 \
    PUPR_USER_DATA=/data \
    TTS_CACHE_DIR=/data/.tts-cache

# `flac` dibutuhkan SpeechRecognition (recognize_google) untuk konversi audio di Linux.
# (Di macOS/Windows library memakai binary bundled, di Linux memakai `flac` dari PATH.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends flac \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server_stt.py ./
COPY web ./web

RUN useradd --create-home --uid 10001 pupr \
 && mkdir -p /data/.tts-cache \
 && chown -R pupr:pupr /data /app
USER pupr

EXPOSE 8767

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8767/api-status', timeout=4).read()"]

CMD ["python", "server_stt.py"]

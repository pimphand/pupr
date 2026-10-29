import http from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSession, getModelConfig, makeInputTensors } from './loadModel.js';
import { textToPhonemeIds } from './phoneme.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(path, res) {
  const ext = extname(path).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
  };
  const body = readFileSync(path);
  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Content-Length': body.length });
  res.end(body);
}

const PORT = process.env.PORT || 8765;
let session = null;
let modelConfig = null;

async function ensureModel() {
  console.log('[server] ensureModel() called, session:', !!session);
  if (session) return session;
  try {
    session = await getSession();
    console.log('[server] after getSession, session:', !!session);
    modelConfig = await getModelConfig();
  } catch (err) {
    console.warn('[server] ensureModel eror:', err.message);
  }
  return session;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/synthesize' && req.method === 'POST') {
    await ensureModel();
    if (!session) {
      return sendJSON(res, 503, { error: 'Model ONNX belum dimuat. Cek log server.' });
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { text, rate, noiseScale, lengthScale, noiseW } = JSON.parse(body || '{}');
        if (!text || typeof text !== 'string') {
          return sendJSON(res, 400, { error: 'Parameter "text" (string) diperlukan.' });
        }
        const scales = [noiseScale ?? 0.667, lengthScale ?? 1.0, noiseW ?? 0.8];
        const ids = await textToPhonemeIds(text);
        if (ids.length === 0) { return sendJSON(res, 400, { error: 'Teks tidak menghasilkan fonem.' }); }
        const tensors = makeInputTensors(ids, scales);
        const result = await session.run(tensors);
        const mel = result.output;
        sendJSON(res, 200, {
          ok: true, model: 'piper_onnx',
          sampleRate: rate ?? (modelConfig?.audio?.sample_rate || 22050),
          phonemeIds: ids,
          frames: mel.shape && mel.shape.length >= 2 ? mel.shape[1] : 0,
          numBins: mel.shape && mel.shape.length >= 3 ? mel.shape[2] : 0,
          note: 'Model menghasilkan mel-spectrogram.',
        });
      } catch (err) {
        sendJSON(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, timestamp: Date.now() });
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return sendFile(join(__dirname, 'dist', 'index.html'), res);
  }

  const filePath = decodeURIComponent(url.pathname.slice(1));
  const fullPath = join(__dirname, 'dist', filePath);
  if (!fullPath.startsWith(join(__dirname, 'dist'))) return sendJSON(res, 403, { error: 'Forbidden' });
  sendFile(fullPath, res);
});

server.listen(PORT, () => {
  console.log(`TTS server berjalan di http://localhost:${PORT}`);
});

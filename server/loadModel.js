import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the native backend and initialize it before any session creation.
const binding = require('./node_modules/onnxruntime-node/dist/binding.js');
if (typeof binding.initOrt === 'function') {
  binding.initOrt();
}

const ort = require('./node_modules/onnxruntime-node/dist/index.js');

let session = null;

export async function loadModel(modelPath) {
  if (session) return session;
  const sessionOpts = {
    executionProviders: ['CPUExecutionProvider'],
    intraThreads: 1,
  };
  session = await ort.InferenceSession.create(modelPath, sessionOpts);
  return session;
}

export function getModelPath() {
  return join(__dirname, '..', 'dist', 'models', 'model.onnx');
}

export function makeInputTensors(ids, scales) {
  const seq = ids.slice(0, 512);
  const inputLength = Math.min(seq.length, 4096);
  const batch = 1;
  const inputData = new Int64Array(seq.length);
  for (let i = 0; i < seq.length; i++) inputData[i] = ids[i];
  const inputTensor = new ort.Tensor('int64', inputData, [batch, seq.length]);
  const inputLengths = new Int32Array([inputLength]);
  const scalesTensor = new ort.Tensor('float32', scales, [3]);
  return { input: inputTensor, input_lengths: inputLengths, scales: scalesTensor };
}

export async function getSession() {
  if (!session) {
    try {
      session = await loadModel(getModelPath());
    } catch (err) {
      throw new Error(`Gagal memuat model ONNX: ${err.message}`);
    }
  }
  return session;
}

export function getModelConfig() {
  const configPath = join(__dirname, '..', 'dist', 'models', 'config.json');
  const raw = readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

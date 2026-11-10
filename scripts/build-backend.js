const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const scriptCandidates = [
  path.join(root, 'tts', 'server_stt.py'),
  path.join(root, 'server_stt.py'),
];
const script = scriptCandidates.find((p) => fs.existsSync(p));
const outDir = path.join(root, 'tts'); // place exe in tts/ (bundled via extraResources)

if (!script) {
  console.error('[build-backend] server_stt.py not found (looked in tts/ and project root)');
  process.exit(1);
}
try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}

// Prefer pyinstaller on PATH; fall back to python -m PyInstaller.
let cmd = 'pyinstaller';
let args = [];
const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
if (probe.status !== 0) {
  // try python -m PyInstaller
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const probe2 = spawnSync(py, ['-m', 'PyInstaller', '--version'], { stdio: 'ignore' });
  if (probe2.status !== 0) {
    console.warn('[build-backend] PyInstaller not found. Skipping backend bundle; client will need Python or a bundled runtime.');
    console.warn('[build-backend] Install with: pip install pyinstaller');
    process.exit(0);
  }
  cmd = py;
  args = ['-m', 'PyInstaller'];
}

const fullArgs = args.concat([
  '--noconfirm',
  '--onefile',
  '--name', 'server_stt',
  // speech_recognition menyimpan konverter FLAC (flac-win32.exe/flac-mac/flac-linux-*) sebagai
  // package data di dalam foldernya sendiri; tanpa flag ini /stt gagal di exe ("FLAC conversion
  // utility not available") karena library mencarinya relatif terhadap __file__ (folder _MEIPASS).
  '--collect-data', 'speech_recognition',
  '--distpath', outDir,
  '--workpath', path.join(root, 'build', 'pyinstaller'),
  '--specpath', path.join(root, 'build', 'pyinstaller'),
  script,
]);

console.log('[build-backend] running:', cmd, fullArgs.join(' '));
const res = spawnSync(cmd, fullArgs, { stdio: 'inherit', cwd: root });
if (res.status !== 0) {
  console.error('[build-backend] failed with code', res.status);
  process.exit(res.status || 1);
}
const exe = path.join(outDir, process.platform === 'win32' ? 'server_stt.exe' : 'server_stt');
if (fs.existsSync(exe)) {
  console.log('[build-backend] produced', exe);
} else {
  console.warn('[build-backend] expected exe not found at', exe);
}

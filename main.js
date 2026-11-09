const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const DEFAULT_CONFIG = {
  app: { name: 'Resepsionis Virtual PUPR', language: 'id-ID' },
  electron: { window: { width: 1280, height: 800 }, permissions: { media: true, audioCapture: true, microphone: true } },
  backend: { enabled: true, host: '127.0.0.1', port: 8767, pythonScript: 'server_stt.py', autoStart: true }
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override ?? base;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(override)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base?.[k] === 'object' && !Array.isArray(base?.[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

function getAppRoot() {
  // In packaged builds, ship backend/config/assets as extraResources under resources/app-files (outside asar).
  if (app.isPackaged) {
    const candidates = [
      path.join(process.resourcesPath, 'app-files'),
      path.join(process.resourcesPath, 'app'),
      process.resourcesPath,
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'index.html'))) return c;
    }
    return path.join(process.resourcesPath, 'app-files');
  }
  return __dirname;
}

function getUserConfigPath() {
  try { return path.join(app.getPath('userData'), 'app.config.json'); } catch (_) { return ''; }
}

function readJsonSafe(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn('[config] Failed to load', filePath, e.message);
  }
  return null;
}

function loadAppConfig() {
  const appRoot = getAppRoot();
  // Priority: userData override > bundled/app config > defaults. User override lets packaged EXE be configured without editing bundled files.
  const fromApp = readJsonSafe(path.join(appRoot, 'app.config.json')) || readJsonSafe(path.join(__dirname, 'app.config.json'));
  const fromUser = readJsonSafe(getUserConfigPath());
  return deepMerge(deepMerge(DEFAULT_CONFIG, fromApp || {}), fromUser || {});
}

let appConfig = DEFAULT_CONFIG;
let APP_ROOT = __dirname;

const { spawnSync } = require('child_process');

function isRealPython(cmd, extraArgs) {
  try {
    const args = (extraArgs || []).concat(['--version']);
    const r = spawnSync(cmd, args, { windowsHide: true, timeout: 5000, encoding: 'utf8', shell: false });
    if (r.error) return false;
    // Microsoft Store alias stub exits 9009 and prints install hint; real python exits 0.
    if (r.status !== 0 && r.status !== null) {
      // Some builds print version to stderr but still exit 0; guard against 9009 alias.
      if (r.status === 9009) return false;
    }
    const out = String((r.stdout || '') + (r.stderr || ''));
    return /Python\s+\d/i.test(out);
  } catch (_) {
    return false;
  }
}

function getPythonCommand() {
  if (process.env.PYTHON_EXECUTABLE) return process.env.PYTHON_EXECUTABLE;
  if (process.platform === 'win32') {
    // Prefer the Windows Python Launcher (py), which is not affected by the
    // Microsoft Store "python" app-execution alias stub that exits 9009.
    const candidates = [];
    if (process.env.PYTHON) candidates.push(process.env.PYTHON);
    candidates.push('py', 'python3', 'python');
    // Discover any python on PATH via `where` (filters out the Store alias stub).
    try {
      for (const name of ['py', 'python', 'python3']) {
        const w = spawnSync('where', [name], { windowsHide: true, timeout: 5000, encoding: 'utf8', shell: false });
        if (w.status === 0 && w.stdout) {
          for (const line of String(w.stdout).split(/\r?\n/)) {
            const pth = line.trim();
            if (pth) candidates.push(pth);
          }
        }
      }
    } catch (_) {}
    for (const ver of ['313', '312', '311', '310', '39']) {
      candidates.push(`C:\\Python${ver}\\python.exe`);
      candidates.push(`C:\\Program Files\\Python${ver}\\python.exe`);
      const local = process.env.LOCALAPPDATA;
      if (local) candidates.push(path.join(local, 'Programs', 'Python', `Python${ver}`, 'python.exe'));
      const pf = process.env.ProgramFiles;
      if (pf) candidates.push(path.join(pf, `Python${ver}`, 'python.exe'));
    }
    for (const c of candidates) {
      if (!c || /\s/.test(c) && !fs.existsSync(c)) continue;
      // Absolute paths must exist.
      if (c.includes('\\') && !fs.existsSync(c)) continue;
      if (isRealPython(c, [])) return c;
    }
    return null;
  }
  // Dev fallbacks (macOS). Avoid hard-coding these as requirements for packaged builds.
  for (const p of ['/opt/homebrew/bin/python3.11', '/usr/local/bin/python3.11', '/usr/bin/python3', 'python3']) {
    if (p === 'python3' || fs.existsSync(p)) return p;
  }
  return 'python3';
}

function resolveBackendLaunch(backend) {
  const root = APP_ROOT;
  const isWin = process.platform === 'win32';
  // Prefer a bundled backend executable when packaged (no local Python dependency).
  const exeNames = isWin ? ['server_stt.exe', 'pupr-backend.exe', 'backend.exe'] : ['server_stt', 'pupr-backend', 'backend'];
  for (const name of exeNames) {
    for (const dir of [root, path.join(process.resourcesPath || '', 'backend'), process.resourcesPath || '']) {
      const p = dir ? path.join(dir, name) : '';
      if (p && fs.existsSync(p)) return { command: p, args: [], cwd: path.dirname(p), bundled: true };
    }
  }
  const script = path.join(root, backend.pythonScript || 'server_stt.py');
  // Prefer a bundled portable Python runtime (shipped with the app) so clients
  // do not need to install Python themselves.
  const runtimeNames = ['python', 'python-runtime', 'python3'];
  const baseDirs = [root, process.resourcesPath || ''];
  for (const base of baseDirs) {
    for (const name of runtimeNames) {
      const rtDir = path.join(base, name);
      const candidate = path.join(rtDir, 'python.exe');
      if (fs.existsSync(candidate) && isRealPython(candidate, [])) {
        return { command: candidate, args: [script], cwd: rtDir, bundled: false, script, runtime: true };
      }
    }
  }
  // Also try nested runtime dir: <root>/python/python.exe already covered.
  const python = getPythonCommand();
  if (!python) {
    return { command: null, args: [], cwd: root, bundled: false, script, unavailable: true };
  }
  return { command: python, args: [script], cwd: root, bundled: false, script };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
};

function createStaticServer(root) {
  return http.createServer((req, res) => {
    let urlPath = '/';
    try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch (_) {}
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.normalize(path.join(root, urlPath));
    const rootNorm = path.normalize(root + path.sep);
    if (!filePath.startsWith(rootNorm) && filePath !== path.normalize(root)) { res.statusCode = 403; res.end('Forbidden'); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.statusCode = 404; res.end('Not found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      res.end(data);
    });
  });
}

function createWindow() {
  const winCfg = appConfig.electron?.window || {};
  const perms = appConfig.electron?.permissions || {};
  const preloadCandidates = [path.join(APP_ROOT, 'preload.js'), path.join(__dirname, 'preload.js')];
  const preload = preloadCandidates.find((p) => fs.existsSync(p)) || path.join(__dirname, 'preload.js');
  const win = new BrowserWindow({
    width: winCfg.width || 1280,
    height: winCfg.height || 800,
    title: winCfg.title || appConfig.app?.name || 'Resepsionis Virtual',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (perms[permission]) return callback(true);
    if (permission === 'media' || permission === 'audioCapture' || permission === 'microphone') {
      callback(perms.media ?? perms.audioCapture ?? perms.microphone ?? true);
    } else {
      callback(false);
    }
  });
  win.webContents.session.setPermissionCheckHandler(() => true);
  if (appConfig.electron?.userAgent) win.webContents.setUserAgent(appConfig.electron.userAgent);

  const server = createStaticServer(APP_ROOT);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    win.loadURL(`http://127.0.0.1:${port}/`);
  });
  server.on('error', (e) => console.error('[electron] static server error', e.message));
}

let pythonProcess = null;

function stopBackend() {
  if (!pythonProcess || pythonProcess.killed) return;
  try {
    if (process.platform === 'win32' && pythonProcess.pid) {
      // Ensure child tree exits on Windows.
      spawn('taskkill', ['/pid', String(pythonProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      pythonProcess.kill();
    }
  } catch (e) {}
  pythonProcess = null;
}

app.commandLine.appendSwitch('enable-speech-dispatcher');
app.commandLine.appendSwitch('enable-features', 'WebSpeech');

app.whenReady().then(() => {
  APP_ROOT = getAppRoot();
  appConfig = loadAppConfig();

  const backend = appConfig.backend || {};
  if (backend.enabled !== false && backend.autoStart !== false) {
    try {
      const launch = resolveBackendLaunch(backend);
      if (launch.unavailable) {
        console.warn('[py] no usable Python found on this system; backend disabled. Install Python from python.org (not the Microsoft Store alias) or bundle server_stt.exe.');
      } else if (launch.script && !fs.existsSync(launch.script) && !launch.bundled) {
        console.warn('[py] backend script not found (packaged build without bundled backend?):', launch.script);
      } else {
        const env = { ...process.env };
        if (backend.host) env.BACKEND_HOST = String(backend.host);
        if (backend.port) env.BACKEND_PORT = String(backend.port);
        // Prefer config next to backend; fall back to app root.
        const cfgPath = [path.join(launch.cwd, 'app.config.json'), path.join(APP_ROOT, 'app.config.json')].find((p) => fs.existsSync(p));
        if (cfgPath) env.APP_CONFIG_PATH = cfgPath;
        env.PUPR_APP_ROOT = APP_ROOT;
        env.PUPR_USER_DATA = app.getPath('userData');
        // Dashboard/config URLs: use explicit config/env; do NOT force localhost defaults in packaged builds.
        const dashCfg = backend.dashboardConfigUrl || process.env.DASHBOARD_CONFIG_URL || '';
        const dashUsage = backend.dashboardUsageUrl || process.env.DASHBOARD_USAGE_URL || '';
        if (dashCfg) env.DASHBOARD_CONFIG_URL = String(dashCfg);
        if (dashUsage) env.DASHBOARD_USAGE_URL = String(dashUsage);
        if (backend.dashboardConfigToken) env.DASHBOARD_CONFIG_TOKEN = String(backend.dashboardConfigToken);
        // TTS/AI secrets should come from dashboard DB or user-configured env; never bundle .env secrets.
        pythonProcess = spawn(launch.command, launch.args, {
          cwd: launch.cwd || APP_ROOT,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        pythonProcess.stdout.on('data', (d) => console.log('[py]', String(d).trim()));
        pythonProcess.stderr.on('data', (d) => console.log('[py]', String(d).trim()));
        pythonProcess.on('error', (e) => console.warn('[py] spawn error:', e.message));
        pythonProcess.on('exit', (code, sig) => console.log('[py] exit', code, sig));
      }
    } catch (e) {
      console.warn('Failed to start backend:', e.message);
    }
  }
  createWindow();
});

app.on('window-all-closed', () => { stopBackend(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopBackend);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

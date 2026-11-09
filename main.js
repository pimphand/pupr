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

function getPythonCommand() {
  if (process.env.PYTHON_EXECUTABLE) return process.env.PYTHON_EXECUTABLE;
  if (process.platform === 'win32') {
    // Common Windows launchers; packaged app may bundle a backend exe instead (handled separately).
    return process.env.PYTHON || 'python';
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
  return { command: getPythonCommand(), args: [script], cwd: root, bundled: false, script };
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
      if (launch.script && !fs.existsSync(launch.script) && !launch.bundled) {
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

const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const CONFIG_PATH = path.join(__dirname, 'app.config.json');

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

function loadAppConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return deepMerge(DEFAULT_CONFIG, parsed);
    }
  } catch (e) {
    console.warn('[config] Failed to load app.config.json, using defaults:', e.message);
  }
  return DEFAULT_CONFIG;
}

const appConfig = loadAppConfig();

function getPythonCommand() {
  if (process.env.PYTHON_EXECUTABLE) return process.env.PYTHON_EXECUTABLE;
  if (process.platform === 'win32') return 'python';
  if (fs.existsSync('/opt/homebrew/bin/python3.11')) return '/opt/homebrew/bin/python3.11';
  if (fs.existsSync('/usr/local/bin/python3.11')) return '/usr/local/bin/python3.11';
  return 'python3';
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webm': 'video/webm'
};

function createStaticServer(root) {
  return http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(root, urlPath);
    if (!filePath.startsWith(root)) { res.statusCode = 403; res.end('Forbidden'); return; }
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
  const win = new BrowserWindow({
    width: winCfg.width || 1280,
    height: winCfg.height || 800,
    title: winCfg.title || appConfig.app?.name || 'Resepsionis Virtual',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // Grant configurable permissions (media/mic needed for speech features)
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

  const server = createStaticServer(__dirname);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    win.loadURL(`http://127.0.0.1:${port}/`);
  });
}

let pythonProcess = null;

app.commandLine.appendSwitch('enable-speech-dispatcher');
app.commandLine.appendSwitch('enable-features', 'WebSpeech');

app.whenReady().then(() => {
  // Start Python backend (configurable via app.config.json)
  const backend = appConfig.backend || {};
  if (backend.enabled !== false && backend.autoStart !== false) {
    try {
      const script = path.join(__dirname, backend.pythonScript || 'server_stt.py');
      const env = { ...process.env };
      if (backend.host) env.BACKEND_HOST = String(backend.host);
      if (backend.port) env.BACKEND_PORT = String(backend.port);
      env.APP_CONFIG_PATH = CONFIG_PATH;
      // PUPR API keys are stored in Dashboard DB (app_settings). Python backend fetches from dashboard on startup.
      env.DASHBOARD_CONFIG_URL = backend.dashboardConfigUrl || env.DASHBOARD_CONFIG_URL || 'http://127.0.0.1:4321/api/pupr/config';
      env.DASHBOARD_USAGE_URL = backend.dashboardUsageUrl || env.DASHBOARD_USAGE_URL || '';
      if (backend.dashboardConfigToken) env.DASHBOARD_CONFIG_TOKEN = String(backend.dashboardConfigToken);
      pythonProcess = spawn(getPythonCommand(), [script], { cwd: __dirname, env });
      pythonProcess.stdout.on('data', (d) => console.log('[py]', d.toString().trim()));
      pythonProcess.stderr.on('data', (d) => console.log('[py]', d.toString().trim()));
      pythonProcess.on('error', (e) => console.warn('[py] spawn error:', e.message));
    } catch (e) {
      console.warn('Failed to start Python backend:', e.message);
    }
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (pythonProcess) { try { pythonProcess.kill(); } catch (e) {} }
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  if (pythonProcess) { try { pythonProcess.kill(); } catch (e) {} }
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
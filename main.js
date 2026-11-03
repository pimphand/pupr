const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

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
  '.woff2': 'font/woff2', '.ttf': 'font/ttf'
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
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // Grant microphone permission for SpeechRecognition
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'audioCapture' || permission === 'microphone') {
      callback(true);
    } else {
      callback(false);
    }
  });
  win.webContents.session.setPermissionCheckHandler(() => true);
  win.webContents.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

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
  // Start Python STT backend
  try {
    pythonProcess = spawn(getPythonCommand(), [path.join(__dirname, 'server_stt.py')], { cwd: __dirname });
    pythonProcess.stdout.on('data', (d) => console.log('[py]', d.toString().trim()));
    pythonProcess.stderr.on('data', (d) => console.log('[py]', d.toString().trim()));
  } catch (e) {
    console.warn('Failed to start Python backend:', e.message);
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
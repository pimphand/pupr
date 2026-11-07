const { contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');

function readConfigSafe() {
  try {
    const configPath = path.join(__dirname, 'app.config.json');
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {}
  return null;
}

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  // Optional: renderer primarily loads /app.config.json via fetch, but this is available for early boot/debug.
  getAppConfig: () => readConfigSafe()
});
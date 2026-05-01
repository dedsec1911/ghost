const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');

// ─── Process name ────────────────────────────────────────────────────────────
process.title = 'ghost';

let mainWindow = null;
let tray = null;

// ─── Request macOS permissions on launch ──────────────────────────────────────
async function requestMicrophone() {
  if (process.platform === 'darwin') {
    try {
      const status = await systemPreferences.askForMediaAccess('microphone');
      console.log('Microphone permission status:', status);
      return status;
    } catch (err) {
      console.error('Error requesting microphone permission:', err);
      return false;
    }
  }
  return true;
}

// ─── Window creation ─────────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    x: width - 440,
    y: 60,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,            // hide from taskbar / dock
    resizable: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    // macOS: hide from app switcher
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
  });

  // ── CRITICAL: invisible to screen capture ──────────────────────────────────
  // macOS: setContentProtection prevents the window from appearing in
  // screenshots, screen recordings, and screen sharing (Zoom, Meet, Teams).
  // Windows: same API call uses WDA_EXCLUDEFROMCAPTURE on Win10 2004+.
  mainWindow.setContentProtection(true);

  // macOS: hide from Mission Control / Exposé
  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    app.dock.hide();
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Keep always-on-top even when other windows go fullscreen
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Tray icon (minimal — just quit) ─────────────────────────────────────────
function createTray() {
  // Create a tiny 1x1 transparent image as tray icon to stay hidden
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide (Ctrl+Shift+H)', click: toggleWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.setToolTip('ghost');
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Request microphone permission on macOS before window is created
  if (process.platform === 'darwin') {
    await requestMicrophone();
  }
  
  createWindow();
  createTray();

  // Global hotkeys
  globalShortcut.register('CommandOrControl+Shift+H', toggleWindow);
  globalShortcut.register('CommandOrControl+Shift+X', () => app.quit());

  app.on('activate', () => { if (!mainWindow) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// ─── IPC handlers ────────────────────────────────────────────────────────────

// Window drag
ipcMain.on('window-drag', (_, { deltaX, deltaY }) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + deltaX, y + deltaY);
});

// Window resize
ipcMain.on('window-resize', (_, { width, height }) => {
  if (!mainWindow) return;
  mainWindow.setSize(Math.max(300, width), Math.max(200, height));
});

// Close / minimise
ipcMain.on('window-close', () => mainWindow && mainWindow.hide());
ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());

// Toggle content protection (for testing — normally always ON)
ipcMain.on('toggle-protection', (_, enabled) => {
  if (mainWindow) mainWindow.setContentProtection(enabled);
});

// Request microphone permission from renderer
ipcMain.handle('request-microphone-permission', async () => {
  if (process.platform === 'darwin') {
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      console.log('Microphone permission result:', granted);
      return granted;
    } catch (err) {
      console.error('Error requesting microphone:', err);
      return false;
    }
  }
  // On non-macOS, permission is typically requested by getUserMedia
  return true;
});

ipcMain.handle('get-runtime-info', () => ({
  platform: process.platform,
  isPackaged: app.isPackaged,
}));

ipcMain.handle('read-model-file', async () => {
  const modelName = 'vosk-model-small-en-us-0.15.tar.gz';
  const modelPath = path.join(app.getAppPath(), 'assets', 'model', modelName);
  const buffer = await fs.promises.readFile(modelPath);
  return Array.from(buffer);
});

// Save context to userData
ipcMain.handle('save-context', (_, data) => {
  const file = path.join(app.getPath('userData'), 'context.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return true;
});

ipcMain.handle('load-context', () => {
  const file = path.join(app.getPath('userData'), 'context.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return null;
});

// Read uploaded file (PDF text via pdfjs, docx via mammoth, plain text)
ipcMain.handle('read-file', async (_, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);

  if (ext === '.txt' || ext === '.md') {
    return buf.toString('utf8');
  }
  if (ext === '.pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buf);
      return data.text;
    } catch (e) {
      return `[PDF parse error: ${e.message}]`;
    }
  }
  if (ext === '.docx') {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer: buf });
      return result.value;
    } catch (e) {
      return `[DOCX parse error: ${e.message}]`;
    }
  }
  return '[Unsupported file type — use .txt, .pdf, or .docx]';
});

// NVIDIA API proxy (avoids CORS from renderer)
ipcMain.handle('nvidia-chat', async (_, { apiKey, model, messages, stream }) => {
  const fetch = require('node-fetch');
  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'openai/gpt-oss-120b',
      messages,
      max_tokens: 1024,
      stream: false,
      temperature: 0.6,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`NVIDIA API ${resp.status}: ${err}`);
  }
  return resp.json();
});

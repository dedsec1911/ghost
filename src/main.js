const { app, BrowserWindow, ipcMain, screen, globalShortcut, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const asrService = require('./stt/asr-service');
const modelStore = require('./stt/model-store');

// ─── Process name ────────────────────────────────────────────────────────────
process.title = 'ghost';

let mainWindow = null;

const ALLOWED_MODELS = new Set([
  'poolside/laguna-xs-2.1',
  'z-ai/glm-5.2',
  'stepfun-ai/step-3.7-flash',
  'deepseek-ai/deepseek-v4-flash',
  'google/gemma-4-31b-it',
  'meta/llama-3.1-70b-instruct',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'moonshotai/kimi-k3',
  'deepseek-ai/deepseek-v4-pro-0813',
]);
const DEFAULT_MODEL = 'poolside/laguna-xs-2.1';
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;

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
  mainWindow.setSkipTaskbar(true);

  // macOS: hide from Mission Control / Exposé
  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (app.dock && typeof app.dock.hide === 'function') app.dock.hide();
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Speech-to-text events are pushed to this window.
  asrService.setTarget(mainWindow.webContents);

  // Keep always-on-top even when other windows go fullscreen
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    hideWindowCompletely();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    hideWindowCompletely();
  } else {
    if (process.platform === 'darwin' && typeof app.show === 'function') app.show();
    mainWindow.setSkipTaskbar(true);
    mainWindow.show();
    mainWindow.focus();
  }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Downloaded models live outside the app bundle so upgrades do not discard
  // the Parakeet model.
  modelStore.setModelsRoot(path.join(app.getPath('userData'), 'models'));

  // Request microphone permission on macOS before window is created
  if (process.platform === 'darwin') {
    await requestMicrophone();
  }
  
  createWindow();

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
  asrService.shutdown();
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

// Close / minimise both mean "hide completely". Native minimization can leave
// a taskbar/Dock representation on some Windows and macOS versions.
function hideWindowCompletely() {
  if (!mainWindow) return;
  mainWindow.setSkipTaskbar(true);
  mainWindow.hide();
  if (process.platform === 'darwin' && typeof app.hide === 'function') app.hide();
}

ipcMain.on('window-close', hideWindowCompletely);
ipcMain.on('window-minimize', hideWindowCompletely);

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

// ─── Speech-to-text ──────────────────────────────────────────────────────────

ipcMain.handle('stt-capabilities', () => ({
  sherpaAvailable: asrService.isSherpaAvailable(),
  models: modelStore.status(),
  defaultCloud: asrService.DEFAULT_CLOUD,
}));

ipcMain.handle('stt-start', async (_, options) => asrService.start(options || {}));

ipcMain.handle('stt-stop', () => {
  asrService.stop();
  return true;
});

ipcMain.handle('stt-flush', () => {
  asrService.flush();
  return true;
});

// `send`, not `handle`: audio arrives ~10x per second and must never make the
// renderer's capture loop wait on a reply.
ipcMain.on('stt-audio', (_, samples) => {
  asrService.pushAudio(samples);
});

ipcMain.on('stt-input-rate', (_, sampleRate) => {
  asrService.setInputSampleRate(sampleRate);
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

// Abort handles for chat requests that are still running, keyed by the
// renderer's requestId. Needed because a slow model can otherwise hold the
// answer pane hostage with no way out.
const inFlightChats = new Map();

const CHAT_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Transient upstream conditions. A 504 from integrate.api.nvidia.com almost
// always means the target model is cold-starting or saturated rather than that
// the request was wrong, so retrying the identical body usually works.
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_CHAT_ATTEMPTS = 3;

// Bounded waits rather than one total cap: a total cap would either truncate a
// legitimately long answer or let a dead socket hang forever.
const FIRST_BYTE_TIMEOUT_MS = 40_000;
const BETWEEN_BYTES_TIMEOUT_MS = 25_000;

// Time to generate scales with the number of tokens produced, so the ceiling is
// matched to the answer style instead of always requesting the maximum.
const MAX_TOKENS_BY_STYLE = { concise: 500, star: 900, code: 1200, detailed: 1400 };
const MAX_TOKENS_THINKING = 4096;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function describeChatFailure(status, detail, model) {
  if (status === 401 || status === 403) {
    return 'NVIDIA rejected the API key. Check it in Settings.';
  }
  if (status === 404) {
    return `Model "${model}" was not found. Press the ↻ button next to Model in Settings to see which models this key can use.`;
  }
  if (status === 429) {
    return 'NVIDIA is rate limiting this API key. Wait a few seconds, then ask again.';
  }
  if (status === 504 || status === 502 || status === 503) {
    return `"${model}" did not respond in time (HTTP ${status}) after ${MAX_CHAT_ATTEMPTS} attempts. That model is overloaded or cold-starting — switch to a smaller model in Settings, or try again shortly.`;
  }
  return `NVIDIA API ${status}${detail ? ` — ${detail}` : ''}`;
}

// NVIDIA API proxy (avoids CORS from renderer)
ipcMain.handle('nvidia-chat', async (event, {
  apiKey,
  model,
  messages,
  answerStyle = 'concise',
  enableThinking = false,
  stream = false,
  requestId,
}) => {
  const fetch = require('node-fetch');
  const selectedModel = ALLOWED_MODELS.has(model) || MODEL_ID_PATTERN.test(model || '') ? model : DEFAULT_MODEL;
  const maxTokens = enableThinking
    ? MAX_TOKENS_THINKING
    : (MAX_TOKENS_BY_STYLE[answerStyle] || 1024);

  // A user-initiated stop must not be retried, so it is tracked separately from
  // the per-attempt abort used for stall detection.
  let userAborted = false;
  let attemptController = null;
  if (requestId) {
    inFlightChats.set(requestId, {
      abort() {
        userAborted = true;
        if (attemptController) attemptController.abort();
      },
    });
  }

  // Outside the loop so a partial answer survives a late failure.
  let content = '';
  let lastFailure = null;

  const body = JSON.stringify({
    model: selectedModel,
    messages,
    max_tokens: maxTokens,
    stream: Boolean(stream),
    temperature: 1,
    top_p: 0.95,
    chat_template_kwargs: {
      enable_thinking: Boolean(enableThinking),
    },
  });

  const notifyRetry = (attempt, status) => {
    if (event.sender.isDestroyed()) return;
    event.sender.send('nvidia-chat-retry', {
      requestId, attempt, of: MAX_CHAT_ATTEMPTS, status: status || null,
    });
  };

  try {
    for (let attempt = 1; attempt <= MAX_CHAT_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      attemptController = controller;

      let timer = null;
      let timedOut = false;
      const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
      };

      try {
        arm(FIRST_BYTE_TIMEOUT_MS);

        const resp = await fetch(CHAT_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: stream ? 'text/event-stream' : 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body,
          signal: controller.signal,
        });

        if (!resp.ok) {
          const detail = (await resp.text().catch(() => '')).slice(0, 300).trim();
          const message = describeChatFailure(resp.status, detail, selectedModel);
          if (RETRYABLE_STATUS.has(resp.status) && attempt < MAX_CHAT_ATTEMPTS) {
            lastFailure = message;
            notifyRetry(attempt, resp.status);
            await delay(attempt * 1500);
            continue;
          }
          // Returned, not thrown. An upstream refusal is an expected outcome; a
          // rejection would print an Electron stack trace to the terminal and
          // wrap the message in "Error invoking remote method" boilerplate.
          return { error: message };
        }

        if (!stream) {
          const json = await resp.json();
          return json;
        }

        let pending = '';
        for await (const chunk of resp.body) {
          // Every byte resets the watchdog, so a long answer is never cut off
          // while it is genuinely still arriving.
          arm(BETWEEN_BYTES_TIMEOUT_MS);
          pending += chunk.toString('utf8');
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (typeof delta !== 'string' || !delta) continue;
              content += delta;
              if (!event.sender.isDestroyed()) {
                event.sender.send('nvidia-chat-chunk', { requestId, delta });
              }
            } catch (_) {
              // A malformed SSE line should not discard the rest of the response.
            }
          }
        }
        return { choices: [{ message: { content } }] };
      } catch (err) {
        // Cancellation is a normal outcome. Hand back whatever streamed.
        if (userAborted) {
          return { aborted: true, choices: [{ message: { content } }] };
        }

        // Text already displayed cannot be retried without duplicating it, so a
        // late failure keeps the partial answer and flags it as cut short.
        if (content) {
          return { truncated: true, choices: [{ message: { content } }] };
        }

        lastFailure = timedOut
          ? `"${selectedModel}" sent nothing for ${Math.round(FIRST_BYTE_TIMEOUT_MS / 1000)}s. It is overloaded or cold-starting — try a smaller model in Settings.`
          : `Could not reach the NVIDIA API: ${err.message}`;

        if (attempt < MAX_CHAT_ATTEMPTS) {
          notifyRetry(attempt, null);
          await delay(attempt * 1500);
          continue;
        }
        return { error: lastFailure };
      } finally {
        clearTimeout(timer);
      }
    }

    return { error: lastFailure || 'The NVIDIA API could not be reached.' };
  } finally {
    if (requestId) inFlightChats.delete(requestId);
  }
});

// Cancels one request, or every in-flight request when no id is given.
ipcMain.handle('nvidia-chat-abort', (_, requestId) => {
  if (requestId) {
    const controller = inFlightChats.get(requestId);
    if (!controller) return 0;
    controller.abort();
    return 1;
  }
  const count = inFlightChats.size;
  for (const controller of inFlightChats.values()) controller.abort();
  return count;
});

ipcMain.handle('nvidia-list-models', async (_, apiKey) => {
  if (!apiKey) throw new Error('Add your NVIDIA API key to check model availability.');
  const fetch = require('node-fetch');
  const resp = await fetch('https://integrate.api.nvidia.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`NVIDIA models API ${resp.status}: ${detail}`);
  }
  const result = await resp.json();
  return (result?.data || []).map(item => item?.id).filter(Boolean);
});

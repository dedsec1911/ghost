'use strict';

// Main-process owner of the speech-to-text pipeline.
//
// The renderer captures audio and streams raw PCM here; this module forwards it
// to the recognizer child process and pushes transcripts back to the renderer.

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const modelStore = require('./model-store');

const DEFAULT_CLOUD = {
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'whisper-large-v3-turbo',
  language: 'en',
  // Nudges Whisper towards interview vocabulary instead of generic prose.
  prompt: 'Technical job interview. Software engineering terms, frameworks, and acronyms.',
};

let target = null;          // BrowserWindow.webContents to notify
let child = null;
let childEngine = null;
let childReady = false;
let cloudConfig = { ...DEFAULT_CLOUD };
let cloudApiKey = '';
let cloudInFlight = 0;
// Bumped on every start() so a deferred cleanup from an earlier stop() can tell
// that a new capture session has begun and skip itself.
let sessionId = 0;

// Resolved when the child reports that its models are loaded. `start()` waits
// on this so the renderer does not open the microphone and stream audio into a
// recognizer that is still reading 640 MB of weights off disk.
let readySettle = null;

function settleReady(err) {
  const settle = readySettle;
  readySettle = null;
  if (!settle) return;
  if (err) settle.reject(err);
  else settle.resolve();
}

function send(channel, payload) {
  if (target && !target.isDestroyed()) target.send(channel, payload);
}

function setTarget(webContents) {
  target = webContents;
}

// Native modules cannot be loaded from inside app.asar, so electron-builder is
// configured to unpack them. Resolve to the unpacked copy when running packaged.
function unpacked(p) {
  return p.includes(`app.asar${path.sep}`)
    ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    : p;
}

// sherpa-onnx ships as two packages: the JavaScript wrapper (sherpa-onnx-node)
// and a prebuilt binary package per platform holding sherpa-onnx.node plus its
// shared libraries. Win32 is published as "win", not "win32".
function platformPackageName() {
  const platform = process.platform === 'win32' ? 'win' : process.platform;
  return `sherpa-onnx-${platform}-${process.arch}`;
}

function resolveOrNull(request) {
  try {
    return unpacked(require.resolve(request));
  } catch (_) {
    return null;
  }
}

/** Absolute path to the wrapper's entry point, or null when not installed. */
function sherpaModulePath() {
  return resolveOrNull('sherpa-onnx-node');
}

/** Directory holding sherpa-onnx.node and its shared libraries. */
function sherpaBinaryDir() {
  const entry = resolveOrNull(platformPackageName());
  return entry ? path.dirname(entry) : null;
}

/** True when both the wrapper and this platform's binaries are present. */
function isSherpaAvailable() {
  const dir = sherpaBinaryDir();
  return Boolean(
    sherpaModulePath() && dir && fs.existsSync(path.join(dir, 'sherpa-onnx.node')),
  );
}

// The prebuilt dylibs/so files sit next to the addon. They currently resolve via
// @loader_path, but the package's own instructions ask for this to be set, so it
// is passed through as insurance against a layout change.
function libraryPathEnv() {
  const dir = sherpaBinaryDir();
  if (!dir) return {};

  if (process.platform === 'win32') {
    return { PATH: `${dir}${path.delimiter}${process.env.PATH || ''}` };
  }

  const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
  const existing = process.env[key];
  return { [key]: existing ? `${dir}${path.delimiter}${existing}` : dir };
}

function stopChild() {
  if (!child) return;
  const dying = child;
  child = null;
  childReady = false;
  childEngine = null;
  settleReady(new Error('The speech-to-text engine was stopped before it finished loading.'));
  try { dying.send({ type: 'shutdown' }); } catch (_) {}
  // The child exits on `shutdown`; kill only if it ignores it.
  const killTimer = setTimeout(() => { try { dying.kill('SIGKILL'); } catch (_) {} }, 1500);
  dying.once('exit', () => clearTimeout(killTimer));
  try { dying.stdin.end(); } catch (_) {}
}

/**
 * Boots (or reboots) the recognizer child for the requested engine.
 * @param {{engine: 'parakeet'|'cloud', inputSampleRate: number, cloud?: object}} options
 */
async function start(options) {
  sessionId += 1;
  const engine = options.engine === 'cloud' ? 'cloud' : 'parakeet';

  if (engine === 'cloud') {
    cloudConfig = {
      baseUrl: (options.cloud && options.cloud.baseUrl) || DEFAULT_CLOUD.baseUrl,
      model: (options.cloud && options.cloud.model) || DEFAULT_CLOUD.model,
      language: (options.cloud && options.cloud.language) || DEFAULT_CLOUD.language,
      prompt: (options.cloud && options.cloud.prompt) || DEFAULT_CLOUD.prompt,
    };
    cloudApiKey = (options.cloud && options.cloud.apiKey) || '';
    if (!cloudApiKey) {
      throw new Error('Add a cloud speech-to-text API key in Settings before using the cloud engine.');
    }
  }

  if (!isSherpaAvailable()) {
    throw new Error(
      'sherpa-onnx-node is not installed. Run "npm install" in the project folder, then restart the app.',
    );
  }

  const onProgress = (progress) => send('stt-model-progress', progress);

  const vad = await modelStore.ensureAsset('silero-vad', onProgress);
  const initMessage = {
    type: 'init',
    engine,
    vadModel: vad.file,
    inputSampleRate: options.inputSampleRate || 0,
    // Passed as an absolute path because the worker runs from app.asar.unpacked
    // when packaged, where a bare "sherpa-onnx-node" would not resolve.
    sherpaModule: sherpaModulePath(),
  };

  if (engine === 'parakeet') {
    const model = await modelStore.ensureAsset('parakeet-tdt-0.6b-v2', onProgress);
    initMessage.parakeet = {
      encoder: model.files['encoder.int8.onnx'],
      decoder: model.files['decoder.int8.onnx'],
      joiner: model.files['joiner.int8.onnx'],
      tokens: model.files['tokens.txt'],
    };
  }

  // Reuse a healthy child if the engine has not changed. Reloading the model on
  // every Listen toggle would cost several seconds each time.
  if (child && childReady && childEngine === engine) {
    child.send({ type: 'reset' });
    child.send({ type: 'set-input-rate', sampleRate: options.inputSampleRate || 0 });
    return { engine, reused: true };
  }

  stopChild();

  const workerPath = unpacked(path.join(__dirname, 'asr-worker.js'));
  const worker = fork(workerPath, [], {
    // ELECTRON_RUN_AS_NODE turns the Electron binary into a plain Node runtime,
    // so no separate Node install is required on the user's machine.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...libraryPathEnv() },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  child = worker;
  childEngine = engine;
  childReady = false;

  worker.stdout.on('data', (buf) => console.log('[asr]', buf.toString().trimEnd()));
  worker.stderr.on('data', (buf) => console.error('[asr]', buf.toString().trimEnd()));

  worker.on('message', (message) => {
    switch (message && message.type) {
      case 'ready':
        childReady = true;
        settleReady();
        send('stt-status', { state: 'ready', engine });
        break;
      case 'text':
        send('stt-transcript', { text: message.text, engine, durationSeconds: message.durationSeconds });
        break;
      case 'speech':
        send('stt-speech', { active: message.active });
        break;
      case 'segment':
        transcribeCloudSegment(message).catch(err =>
          send('stt-error', { message: err.message }));
        break;
      case 'error':
        // A failure before `ready` means the engine never came up, so it is
        // reported through start() instead of as a passing runtime warning.
        if (readySettle) settleReady(new Error(message.message));
        else send('stt-error', { message: message.message });
        break;
      default:
        break;
    }
  });

  worker.on('exit', (code, signal) => {
    if (worker !== child) return;
    child = null;
    childReady = false;
    childEngine = null;
    settleReady(new Error(
      `The speech-to-text engine exited during startup (code ${code}${signal ? `, signal ${signal}` : ''}).`,
    ));
    send('stt-status', { state: 'stopped', code, signal });
  });

  worker.on('error', (err) => {
    if (readySettle) settleReady(err);
    else send('stt-error', { message: err.message });
  });

  const ready = new Promise((resolve, reject) => { readySettle = { resolve, reject }; });
  // Loading the int8 Parakeet weights off a cold page cache is the slow part.
  const timer = setTimeout(
    () => settleReady(new Error('The speech-to-text engine did not finish loading in time.')),
    90_000,
  );

  worker.send(initMessage);

  try {
    await ready;
  } catch (err) {
    stopChild();
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return { engine, reused: false };
}

/** Feeds mono Float32 samples at the rate declared in `start`. */
function pushAudio(samples) {
  if (!child || !childReady || !samples || !samples.length) return;
  const view = samples instanceof Float32Array ? samples : new Float32Array(samples);
  const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  // A blocked child must not stall the renderer's audio thread; drop instead.
  if (child.stdin.writableLength > 4 * 1024 * 1024) return;
  child.stdin.write(bytes);
}

function setInputSampleRate(sampleRate) {
  if (child) child.send({ type: 'set-input-rate', sampleRate });
}

function flush() {
  if (child && childReady) child.send({ type: 'flush' });
}

// Goes idle rather than tearing the child down: the model stays resident so
// toggling Listen back on is instant instead of costing another model load.
// Memory is released when the app quits, via shutdown().
function stop() {
  if (!child || !childReady) return;
  const idle = child;
  const session = sessionId;
  flush();
  // Let the flushed utterance finish decoding before clearing VAD state. A
  // start() in the meantime means audio is live again, and resetting then would
  // discard the opening of the new utterance.
  setTimeout(() => {
    if (child === idle && session === sessionId) idle.send({ type: 'reset' });
  }, 800);
}

/** Releases the recognizer process and its loaded model. */
function shutdown() {
  stopChild();
}

// ─── Cloud transcription ─────────────────────────────────────────────────────

function buildWav(pcm16, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([header, pcm16]);
}

function buildMultipart(fields, file) {
  const boundary = `----ghoststt${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
    'Content-Type: audio/wav\r\n\r\n',
  ));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

async function transcribeCloudSegment(message) {
  // Whisper bills a 10 s minimum per request, and sub-second blips are almost
  // never a real question, so skip them.
  if (message.durationSeconds < 0.4) return;

  // Bound concurrency so a burst of segments cannot trip the free-tier limit.
  if (cloudInFlight >= 2) {
    send('stt-error', { message: 'Cloud speech-to-text is backed up; a segment was skipped.' });
    return;
  }
  cloudInFlight += 1;

  try {
    const fetch = require('node-fetch');
    const wav = buildWav(Buffer.from(message.pcm16, 'base64'), message.sampleRate);
    const { boundary, body } = buildMultipart(
      {
        model: cloudConfig.model,
        language: cloudConfig.language,
        response_format: 'json',
        temperature: '0',
        prompt: cloudConfig.prompt,
      },
      { name: `segment-${message.index}.wav`, data: wav },
    );

    const resp = await fetch(`${cloudConfig.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloudApiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });

    if (!resp.ok) {
      throw new Error(`Cloud speech-to-text ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }

    const result = await resp.json();
    const text = String(result.text || '').trim();
    if (text) {
      send('stt-transcript', {
        text,
        engine: 'cloud',
        durationSeconds: message.durationSeconds,
      });
    }
  } finally {
    cloudInFlight -= 1;
  }
}

module.exports = {
  DEFAULT_CLOUD,
  setTarget,
  isSherpaAvailable,
  start,
  stop,
  shutdown,
  flush,
  pushAudio,
  setInputSampleRate,
};

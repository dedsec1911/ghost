/* ═══════════════════════════════════════════════════════
  ghost — Renderer Logic
   Handles: drag, tabs, STT, NVIDIA API, context, settings
════════════════════════════════════════════════════════ */

'use strict';

const Vosk = window.Vosk;
const audioCapture = window.ghostAudioCapture;

const STT_ENGINES = {
  parakeet: 'NVIDIA Parakeet (local)',
  cloud: 'Cloud Whisper API',
  vosk: 'Vosk small (bundled, low accuracy)',
};
const DEFAULT_STT_ENGINE = 'parakeet';

const BUILTIN_MODELS = [
  ['poolside/laguna-xs-2.1', 'Poolside Laguna XS 2.1'],
  ['z-ai/glm-5.2', 'Z.ai GLM 5.2'],
  ['stepfun-ai/step-3.7-flash', 'StepFun Step 3.7 Flash'],
  ['deepseek-ai/deepseek-v4-flash', 'DeepSeek V4 Flash'],
  ['google/gemma-4-31b-it', 'Google Gemma 4 31B IT'],
  ['meta/llama-3.1-70b-instruct', 'Meta Llama 3.1 70B Instruct'],
  ['nvidia/nemotron-3-ultra-550b-a55b', 'NVIDIA Nemotron 3 Ultra 550B A55B'],
  ['moonshotai/kimi-k3', 'Moonshot AI Kimi K3'],
  ['deepseek-ai/deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813'],
];
const BUILTIN_MODEL_LABELS = new Map(BUILTIN_MODELS);
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const DEFAULT_MODEL = 'poolside/laguna-xs-2.1';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  isListening: false,
  activeSource: null,
  audioStream: null,
  capture: null,
  listenSession: 0,
  sttEngine: DEFAULT_STT_ENGINE,
  activeSttEngine: null,
  sttCapabilities: null,
  cloudSttKey: '',
  cloudSttBaseUrl: '',
  cloudSttModel: '',
  // Vosk is only instantiated when the bundled fallback engine is selected.
  voskModel: null,
  voskModelPromise: null,
  voskRecognizer: null,
  runtimeInfo: null,
  autoScroll: true,
  apiKey: '',
  model: DEFAULT_MODEL,
  language: 'en-US',
  answerStyle: 'concise',
  enableThinking: false,
  streamResponses: true,
  models: [],
  modelStatuses: new Map(),
  // requestIds of chat calls still running. Auto-listen can fire several, so
  // this is a set rather than a single flag.
  pendingRequests: new Set(),
  context: { role: '', yoe: '', resume: '', notes: '' },
  transcript: [],
  answers: [],
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  statusDot:        $('status-dot'),
  toggleMic:        $('toggle-mic'),
  toggleSpeaker:    $('toggle-speaker'),
  toggleAuto:       $('toggle-auto'),
  toggleAutoscroll: $('toggle-autoscroll'),
  btnListen:        $('btn-listen'),
  listenIcon:       $('listen-icon'),
  heardBox:         $('heard-box'),
  answerBox:        $('answer-box'),
  manualInput:      $('manual-input'),
  btnAsk:           $('btn-ask'),
  btnStopAi:        $('btn-stop-ai'),
  loadingBar:       $('loading-bar'),
  transcriptBox:    $('transcript-box'),
  // context
  ctxRole:          $('ctx-role'),
  ctxYoe:           $('ctx-yoe'),
  ctxResume:        $('ctx-resume'),
  ctxNotes:         $('ctx-notes'),
  btnUploadFile:    $('btn-upload-file'),
  fileInput:        $('file-input'),
  uploadStatus:     $('upload-status'),
  btnSaveContext:   $('btn-save-context'),
  saveStatus:       $('save-status'),
  // settings
  setApikey:        $('set-apikey'),
  setModel:         $('set-model'),
  btnAddModel:      $('btn-add-model'),
  addModelRow:      $('add-model-row'),
  newModelId:       $('new-model-id'),
  btnConfirmModel:  $('btn-confirm-model'),
  btnCancelModel:   $('btn-cancel-model'),
  addModelHint:     $('add-model-hint'),
  btnRefreshModels: $('btn-refresh-models'),
  modelList:        $('model-list'),
  setLanguage:      $('set-language'),
  setStyle:         $('set-style'),
  // speech-to-text
  setSttEngine:     $('set-stt-engine'),
  sttEngineHint:    $('stt-engine-hint'),
  sttCloudFields:   $('stt-cloud-fields'),
  setSttCloudKey:   $('set-stt-cloud-key'),
  btnShowSttKey:    $('btn-show-stt-key'),
  setSttCloudUrl:   $('set-stt-cloud-url'),
  setSttCloudModel: $('set-stt-cloud-model'),
  sttModelStatus:   $('stt-model-status'),
  toggleThinking:   $('toggle-thinking'),
  toggleStreaming:  $('toggle-streaming'),
  setOpacity:       $('set-opacity'),
  opacityLabel:     $('opacity-label'),
  setWidth:         $('set-width'),
  setHeight:        $('set-height'),
  btnApplySize:     $('btn-apply-size'),
  btnShowKey:       $('btn-show-key'),
  btnSaveSettings:  $('btn-save-settings'),
  settingsStatus:   $('settings-status'),
};

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  loadModelCatalog();
  loadSettingsFromStorage();
  loadSttSettingsFromStorage();
  await loadContextFromMain();
  setupTabs();
  setupTitlebar();
  setupResize();
  setupAudioControls();
  setupManualAsk();
  setupContextTab();
  setupSettingsTab();
  setupClearButtons();
  setupSttEvents();
  applyOpacity(+el.setOpacity.value);
  await refreshSttCapabilities();

  if (el.toggleAuto.checked) {
    startListening();
  }

  window.addEventListener('beforeunload', () => forceStopListening());
});

// ─── Tabs ──────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => {
        t.classList.remove('active');
        t.classList.add('hidden');
      });
      btn.classList.add('active');
      const panel = $('tab-' + btn.dataset.tab);
      if (panel) { panel.classList.remove('hidden'); panel.classList.add('active'); }
    });
  });
}

// ─── Titlebar drag + buttons ──────────────────────────────────────────────────
function setupTitlebar() {
  const drag = $('drag-handle');
  let dragging = false, startX = 0, startY = 0;

  drag.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.screenX; startY = e.screenY;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    window.electronAPI.dragWindow({ deltaX: e.screenX - startX, deltaY: e.screenY - startY });
    startX = e.screenX; startY = e.screenY;
  });
  window.addEventListener('mouseup', () => { dragging = false; });

  $('btn-close').addEventListener('click', () => window.electronAPI.closeWindow());
  $('btn-minimize').addEventListener('click', () => window.electronAPI.minimizeWindow());
  $('btn-settings').addEventListener('click', () => switchTab('settings'));
  $('btn-context').addEventListener('click', () => switchTab('context'));
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    if (t.dataset.tab === name) t.click();
  });
}

// ─── Window resize handle ─────────────────────────────────────────────────────
function setupResize() {
  const handle = $('resize-handle');
  let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;

  handle.addEventListener('mousedown', (e) => {
    resizing = true;
    startX = e.clientX; startY = e.clientY;
    startW = window.innerWidth; startH = window.innerHeight;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const w = startW + (e.clientX - startX);
    const h = startH + (e.clientY - startY);
    window.electronAPI.resizeWindow({ width: Math.max(300, w), height: Math.max(200, h) });
  });
  window.addEventListener('mouseup', () => { resizing = false; });
}

// ─── Audio controls setup ─────────────────────────────────────────────────────
function setupAudioControls() {
  el.btnListen.addEventListener('click', () => {
    if (state.isListening) stopListening();
    else startListening();
  });

  el.toggleAuto.addEventListener('change', () => {
    if (el.toggleAuto.checked && !state.isListening) startListening();
    else if (!el.toggleAuto.checked && state.isListening) stopListening();
  });

  el.toggleMic.addEventListener('change', () => handleSourceToggleChange('mic'));
  el.toggleSpeaker.addEventListener('change', () => handleSourceToggleChange('speaker'));
}

function handleSourceToggleChange(changedSource) {
  // The bundled recognizer accepts one mixed input. Treat these as an explicit
  // source selector so the UI never claims speaker audio is captured while the
  // app is actually listening only to the microphone.
  if (changedSource === 'mic' && el.toggleMic.checked) el.toggleSpeaker.checked = false;
  if (changedSource === 'speaker' && el.toggleSpeaker.checked) el.toggleMic.checked = false;
  const selectedSource = getSelectedSourceType();
  if (!selectedSource) {
    if (state.isListening) stopListening();
    return;
  }

  if (!state.isListening) {
    startListening();
    return;
  }

  if (selectedSource !== state.activeSource) {
    restartListening();
  }
}

// ─── Engine selection ─────────────────────────────────────────────────────────

async function refreshSttCapabilities() {
  try {
    state.sttCapabilities = await window.electronAPI.stt.capabilities();
  } catch (err) {
    state.sttCapabilities = null;
  }
  if (!state.cloudSttBaseUrl) {
    state.cloudSttBaseUrl = state.sttCapabilities?.defaultCloud?.baseUrl || '';
  }
  if (!state.cloudSttModel) {
    state.cloudSttModel = state.sttCapabilities?.defaultCloud?.model || '';
  }
  renderSttSettings();
}

// Falls back rather than erroring out: a half-configured engine should not stop
// the app from hearing anything at all.
function resolveSttEngine() {
  const requested = state.sttEngine;
  const sherpaAvailable = state.sttCapabilities?.sherpaAvailable === true;

  if (requested === 'vosk') return { engine: 'vosk' };

  if (!sherpaAvailable) {
    return {
      engine: 'vosk',
      notice: 'sherpa-onnx-node is not installed, so the low-accuracy bundled model is in use. Run "npm install", then restart.',
    };
  }
  if (requested === 'cloud' && !state.cloudSttKey) {
    return {
      engine: 'vosk',
      notice: 'No cloud speech-to-text API key set, so the low-accuracy bundled model is in use.',
    };
  }
  return { engine: requested === 'cloud' ? 'cloud' : 'parakeet' };
}

// ─── Speech-to-text settings UI ───────────────────────────────────────────────

const STT_ENGINE_HINTS = {
  parakeet: 'Runs fully offline on this machine. The first run downloads the model once (~460 MB) into the app data folder.',
  cloud: 'Each detected utterance is uploaded to the endpoint below. Accurate, but audio leaves the machine and free tiers rate-limit.',
  vosk: 'Bundled 40 MB model, nothing to download. Usable, but expect noticeably more errors than the other two.',
};

function renderSttSettings() {
  const sherpaAvailable = state.sttCapabilities?.sherpaAvailable === true;

  el.setSttEngine.innerHTML = '';
  Object.entries(STT_ENGINES).forEach(([id, label]) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    // Shown but unselectable, so the reason it cannot run stays discoverable.
    option.disabled = !sherpaAvailable && id !== 'vosk';
    el.setSttEngine.appendChild(option);
  });

  const { engine: effective, notice } = resolveSttEngine();
  // The select reflects what will actually run; the saved preference is kept in
  // state so it takes effect again once the blocker is resolved.
  el.setSttEngine.value = sherpaAvailable ? state.sttEngine : effective;

  el.setSttCloudKey.value = state.cloudSttKey;
  el.setSttCloudUrl.value = state.cloudSttBaseUrl;
  el.setSttCloudModel.value = state.cloudSttModel;
  el.sttCloudFields.classList.toggle('hidden', state.sttEngine !== 'cloud');

  el.sttEngineHint.textContent = notice
    ? `⚠ ${notice}`
    : STT_ENGINE_HINTS[effective] || '';

  renderSttModelStatus();
}

function renderSttModelStatus() {
  const models = state.sttCapabilities?.models;
  el.sttModelStatus.innerHTML = '';

  if (!models) {
    el.sttModelStatus.textContent = 'Model status is unavailable.';
    return;
  }

  Object.values(models).forEach(info => {
    const row = document.createElement('div');
    row.className = 'model-item';

    const name = document.createElement('span');
    name.className = 'model-item-name';
    name.textContent = info.label;

    const status = document.createElement('span');
    status.className = `model-status ${info.installed ? 'working' : 'unknown'}`;
    status.textContent = info.installed
      ? '● Installed'
      : `○ ${(info.approxBytes / (1024 * 1024)).toFixed(0)} MB download`;

    row.append(name, status);
    el.sttModelStatus.appendChild(row);
  });
}

function readSttSettingsFromFields() {
  state.sttEngine = STT_ENGINES[el.setSttEngine.value] ? el.setSttEngine.value : DEFAULT_STT_ENGINE;
  state.cloudSttKey = el.setSttCloudKey.value.trim();
  state.cloudSttBaseUrl = el.setSttCloudUrl.value.trim();
  state.cloudSttModel = el.setSttCloudModel.value.trim();
}

function persistSttSettings() {
  localStorage.setItem('ih_stt', JSON.stringify({
    engine: state.sttEngine,
    cloudKey: state.cloudSttKey,
    cloudBaseUrl: state.cloudSttBaseUrl,
    cloudModel: state.cloudSttModel,
  }));
}

function loadSttSettingsFromStorage() {
  try {
    const saved = JSON.parse(localStorage.getItem('ih_stt') || 'null');
    if (!saved) return;
    if (STT_ENGINES[saved.engine]) state.sttEngine = saved.engine;
    if (typeof saved.cloudKey === 'string') state.cloudSttKey = saved.cloudKey;
    if (typeof saved.cloudBaseUrl === 'string') state.cloudSttBaseUrl = saved.cloudBaseUrl;
    if (typeof saved.cloudModel === 'string') state.cloudSttModel = saved.cloudModel;
  } catch (_) {
    // Corrupt settings should not stop the app from starting.
  }
}

async function ensureVoskModel() {
  if (state.voskModel) return state.voskModel;
  if (state.voskModelPromise) return state.voskModelPromise;
  if (!Vosk?.createModel) throw new Error('Vosk library failed to load.');

  state.voskModelPromise = (async () => {
    state.runtimeInfo = await window.electronAPI.getRuntimeInfo();
    const modelUrl = await window.electronAPI.getModelPath();
    state.voskModel = await Vosk.createModel(modelUrl);
    return state.voskModel;
  })();

  try {
    return await state.voskModelPromise;
  } catch (err) {
    state.voskModelPromise = null;
    throw err;
  }
}

function getSelectedSourceType() {
  if (el.toggleMic.checked) return 'mic';
  if (el.toggleSpeaker.checked) return 'speaker';
  return null;
}

function getSpeakerUnsupportedMessage() {
  return 'System speaker capture is not available in development on macOS 14+ when the app is launched from Terminal or VS Code. Build and run the packaged app, or use a virtual loopback device such as BlackHole and select it as microphone input.';
}

async function getInputStream(sourceType) {
  if (sourceType === 'speaker') {
    if (state.runtimeInfo?.platform === 'darwin' && !state.runtimeInfo?.isPackaged) {
      throw new Error(getSpeakerUnsupportedMessage());
    }

    // Speaker audio is already a clean digital signal. Echo cancellation and
    // noise suppression would only distort it, which costs accuracy.
    return navigator.mediaDevices.getDisplayMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      // Chromium only offers system/tab audio alongside a video track. The
      // track is never read, so it costs no encoding work.
      video: true,
    });
  }

  if (window.electronAPI?.platform === 'darwin') {
    const granted = await window.electronAPI.requestMicrophonePermission().catch(() => false);
    if (!granted) {
      throw new Error('Microphone access denied. Go to System Settings > Privacy & Security > Microphone and allow this app.');
    }
  }

  // No sampleRate/sampleSize/latency hints: forcing 16 kHz makes some devices
  // negotiate a worse configuration, and the pipeline resamples with a proper
  // stateful resampler anyway.
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });
}

// ─── Start listening ─────────────────────────────────────────────────────────
//
// Flow: resolve engine -> make sure its models exist -> open the input device
// -> stream every captured sample to the recogniser. Models are prepared before
// the device is opened so a first-run download does not hold the microphone.
async function startListening() {
  if (state.isListening) return;
  const session = ++state.listenSession;
  const sourceType = getSelectedSourceType();
  if (!sourceType) {
    showInHeard('Enable Mic or Speaker to start speech-to-text.');
    setStatus('idle');
    return;
  }

  if (!state.runtimeInfo) {
    state.runtimeInfo = await window.electronAPI.getRuntimeInfo().catch(() => null);
    if (session !== state.listenSession) return;
  }

  const { engine, notice } = resolveSttEngine();
  if (notice) showInHeard(`⚠ ${notice}`);

  try {
    if (engine === 'vosk') {
      await startVoskEngine(session, sourceType);
    } else {
      await startNativeEngine(session, sourceType, engine);
    }
  } catch (err) {
    if (session !== state.listenSession) return;
    console.error('[STT] startListening error:', err);
    forceStopListening();
    showInHeard(`⚠ ${err.message}`);
    setStatus('error');
  }
}

// Parakeet (local) and cloud Whisper both run in the main process behind Silero
// VAD; the renderer only captures and forwards audio.
async function startNativeEngine(session, sourceType, engine) {
  setStatus('processing');
  showInHeard(
    engine === 'parakeet'
      ? 'Preparing the local NVIDIA Parakeet model…'
      : 'Connecting the cloud speech-to-text engine…',
  );

  await window.electronAPI.stt.start({
    engine,
    inputSampleRate: 0,
    cloud: engine === 'cloud'
      ? {
          apiKey: state.cloudSttKey,
          baseUrl: state.cloudSttBaseUrl,
          model: state.cloudSttModel,
          // Whisper wants a primary subtag ("en"), not a locale ("en-GB").
          language: (state.language || 'en').slice(0, 2),
        }
      : undefined,
  });
  if (session !== state.listenSession) return;

  const stream = await getInputStream(sourceType);
  if (session !== state.listenSession) {
    stream.getTracks().forEach(track => track.stop());
    return;
  }

  const capture = await audioCapture.startCapture({
    stream,
    onSampleRate: (rate) => {
      if (session !== state.listenSession) return;
      window.electronAPI.stt.setInputSampleRate(rate);
    },
    onSamples: (samples) => {
      if (session !== state.listenSession) return;
      window.electronAPI.stt.pushAudio(samples);
    },
    onError: (err) => {
      if (session !== state.listenSession) return;
      console.error('[STT] capture error:', err);
      showInHeard(`⚠ Audio capture stopped: ${err.message}`);
      forceStopListening();
    },
  });
  if (session !== state.listenSession) {
    await capture.stop();
    stream.getTracks().forEach(track => track.stop());
    return;
  }

  state.audioStream = stream;
  state.capture = capture;
  state.activeSource = sourceType;
  state.activeSttEngine = engine;
  state.isListening = true;

  watchForDisconnect(stream, session, sourceType);
  setListenUI(true);
  setStatus('listening');
  showInHeard(
    engine === 'parakeet'
      ? 'Listening with NVIDIA Parakeet…'
      : 'Listening with cloud Whisper…',
  );
}

// Bundled fallback. Kept because it needs no download, so the app still hears
// something on first launch and when sherpa-onnx is missing. It now receives an
// unbroken sample stream, which alone removes most of its previous garbling.
async function startVoskEngine(session, sourceType) {
  setStatus('processing');
  const model = await ensureVoskModel();
  if (session !== state.listenSession) return;

  const stream = await getInputStream(sourceType);
  if (session !== state.listenSession) {
    stream.getTracks().forEach(track => track.stop());
    return;
  }

  let recognizer = null;
  // Tracked locally because `state.capture` is only assigned after
  // startCapture() resolves, while the first samples arrive before that.
  let captureRate = 0;

  const capture = await audioCapture.startCapture({
    stream,
    onSampleRate: (rate) => {
      if (session !== state.listenSession) return;
      captureRate = rate;
      // Kaldi's feature pipeline is bound to the rate given at construction, so
      // the recognizer has to be rebuilt if the device renegotiates.
      if (recognizer) {
        try { recognizer.remove(); } catch (_) {}
      }
      recognizer = new model.KaldiRecognizer(rate);
      recognizer.setWords(true);

      recognizer.on('partialresult', (message) => {
        const text = message?.result?.partial?.trim();
        if (text && state.isListening) updateInterimHeard(text);
      });
      recognizer.on('result', (message) => {
        const text = message?.result?.text?.trim();
        if (text && state.isListening) handleTranscript(text, sourceType);
      });

      state.voskRecognizer = recognizer;
    },
    onSamples: (samples) => {
      if (session !== state.listenSession || !recognizer || !captureRate) return;
      try {
        recognizer.acceptWaveformFloat(samples, captureRate);
      } catch (err) {
        console.error('[STT] vosk processing error:', err);
      }
    },
    onError: (err) => {
      if (session !== state.listenSession) return;
      console.error('[STT] capture error:', err);
      showInHeard(`⚠ Audio capture stopped: ${err.message}`);
      forceStopListening();
    },
  });
  if (session !== state.listenSession) {
    await capture.stop();
    stream.getTracks().forEach(track => track.stop());
    return;
  }

  state.audioStream = stream;
  state.capture = capture;
  state.activeSource = sourceType;
  state.activeSttEngine = 'vosk';
  state.isListening = true;

  watchForDisconnect(stream, session, sourceType);
  setListenUI(true);
  setStatus('listening');
}

function watchForDisconnect(stream, session, sourceType) {
  stream.getTracks().forEach(track => {
    track.addEventListener('ended', () => {
      if (state.listenSession !== session) return;
      forceStopListening();
      showInHeard(`${sourceType === 'speaker' ? 'Speaker' : 'Microphone'} input disconnected.`);
    }, { once: true });
  });
}

// ─── Transcript arrival ──────────────────────────────────────────────────────
function handleTranscript(text, source) {
  addTranscriptEntry(text, source);
  showInHeard(text);
  if (el.toggleAuto.checked) askAI(text);
}

function setupSttEvents() {
  const stt = window.electronAPI.stt;

  stt.on('stt-transcript', ({ text }) => {
    if (!state.isListening || !text) return;
    handleTranscript(text, state.activeSource || 'unknown');
  });

  stt.on('stt-speech', ({ active }) => {
    if (!state.isListening) return;
    if (active) updateInterimHeard('…');
  });

  stt.on('stt-error', ({ message }) => {
    console.error('[STT]', message);
    showInHeard(`⚠ ${message}`);
  });

  stt.on('stt-status', ({ state: engineState }) => {
    // The recognizer process exiting while listening means audio is going
    // nowhere, so surface it instead of appearing to still work.
    if (engineState === 'stopped' && state.isListening && state.activeSttEngine !== 'vosk') {
      forceStopListening();
      showInHeard('⚠ The speech-to-text engine stopped. Press Listen to restart.');
      setStatus('error');
    }
  });

  stt.on('stt-model-progress', (progress) => {
    const { label, phase, received, total } = progress;
    if (phase === 'extracting') {
      showInHeard(`Unpacking ${label}…`);
      return;
    }
    if (phase === 'ready') return;
    const pct = total ? Math.floor((received / total) * 100) : 0;
    const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(0);
    showInHeard(`Downloading ${label} — ${pct}% (${mb(received)} / ${mb(total)} MB)`);
  });
}

// ─── Stop listening ───────────────────────────────────────────────────────────
function stopListening() {
  if (!state.isListening) return;
  forceStopListening();
}

function forceStopListening() {
  const wasNative = state.activeSttEngine && state.activeSttEngine !== 'vosk';
  state.listenSession += 1;
  state.isListening = false;
  state.activeSource = null;
  state.activeSttEngine = null;

  if (state.capture) {
    const capture = state.capture;
    state.capture = null;
    // Fire and forget: teardown must not block the UI thread.
    Promise.resolve(capture.stop()).catch(() => {});
  }

  if (state.voskRecognizer) {
    try { state.voskRecognizer.remove(); } catch (_) {}
    state.voskRecognizer = null;
  }

  if (state.audioStream) {
    state.audioStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
    state.audioStream = null;
  }

  if (wasNative) {
    // Transcribes whatever was mid-utterance before shutting the engine down.
    window.electronAPI.stt.stop().catch(() => {});
  }

  setListenUI(false);
  setStatus('idle');
}
function restartListening() {
  forceStopListening();
  startListening();
}

// ─── Listen button UI ─────────────────────────────────────────────────────────
function setListenUI(on) {
  if (on) {
    el.btnListen.classList.add('active');
    el.btnListen.innerHTML = '<span id="listen-icon">■</span> Stop';
  } else {
    el.btnListen.classList.remove('active');
    el.btnListen.innerHTML = '<span id="listen-icon">▶</span> Listen';
  }
}

function detectSource() {
  if (state.activeSource) return state.activeSource;
  const selectedSource = getSelectedSourceType();
  if (selectedSource) return selectedSource;
  return 'unknown';
}

function updateInterimHeard(text) {
  el.heardBox.innerHTML = `<span style="color:var(--text-muted);font-style:italic">${escapeHtml(text)}</span>`;
}

function showInHeard(text) {
  el.heardBox.innerHTML = escapeHtml(text);
  if (state.autoScroll) el.heardBox.scrollTop = el.heardBox.scrollHeight;
}

// ─── Manual ask ───────────────────────────────────────────────────────────────
function setupManualAsk() {
  el.btnAsk.addEventListener('click', () => {
    const text = el.manualInput.value.trim();
    if (!text) return;
    showInHeard(text);
    addTranscriptEntry(text, 'manual');
    askAI(text);
    el.manualInput.value = '';
  });

  el.manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      el.btnAsk.click();
    }
  });

  el.btnStopAi.addEventListener('click', stopAI);

  // Esc cancels a slow answer without reaching for the mouse. Gated on there
  // being something to cancel so the key is left alone otherwise.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || state.pendingRequests.size === 0) return;
    e.preventDefault();
    stopAI();
  });
}

// Ask and Stop swap places: in a 420 px overlay there is no room for both, and
// the swap makes it obvious whether a request is still running.
function updateAskBusyUI() {
  const busy = state.pendingRequests.size > 0;
  el.btnAsk.disabled = busy;
  el.btnAsk.classList.toggle('hidden', busy);
  el.btnStopAi.classList.toggle('hidden', !busy);
  el.loadingBar.classList.toggle('hidden', !busy);
}

/** Cancels every chat request still in flight. */
async function stopAI() {
  if (state.pendingRequests.size === 0) return;
  el.btnStopAi.disabled = true;
  try {
    await window.electronAPI.abortNvidiaChat();
  } catch (_) {
    // Each askAI call settles on its own regardless, so there is nothing to
    // report here.
  } finally {
    el.btnStopAi.disabled = false;
  }
}

// A stop, or a connection that died mid-answer, keeps whatever already streamed:
// discarding it would throw away text the user may have been reading.
function handleInterruptedAnswer(partial, question, view, reason) {
  const text = String(partial || '').trim();
  const truncated = reason === 'truncated';

  if (text) {
    const marker = truncated
      ? '⚠ *Cut short — the connection stalled. Ask again for the rest.*'
      : '⏹ *Stopped.*';
    view.body.innerHTML = formatMarkdown(`${text}\n\n${marker}`);
    recordAnswer(text, question);
  } else {
    view.body.innerHTML = formatMarkdown(truncated
      ? '⚠ *The model stopped responding before sending anything.*'
      : '⏹ *Stopped before the model replied.*');
  }

  // Restore the question so asking again is one click, unless the box already
  // holds something the user typed in the meantime.
  if (!el.manualInput.value.trim()) el.manualInput.value = question;
}

// Electron wraps a rejected IPC handler as
// "Error invoking remote method 'x': Error: <real message>". That boilerplate
// buries the part the user needs to act on.
function cleanIpcError(message) {
  const cleaned = String(message || '')
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:Error|TypeError|RangeError):\s*/, '')
    .trim();
  return cleaned || 'Something went wrong.';
}

// ─── NVIDIA AI call ───────────────────────────────────────────────────────────
async function askAI(question) {
  if (!state.apiKey) {
    appendAnswer('⚠ No NVIDIA API key set. Please add it in the Settings tab.', question);
    return;
  }

  setStatus('processing');

  const systemPrompt = buildSystemPrompt();
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question },
  ];

  const requestId = crypto.randomUUID();
  state.pendingRequests.add(requestId);
  updateAskBusyUI();

  // The view is created up front so a slow model shows a live "waiting" line
  // with an elapsed count instead of an inert spinner. It is replaced by the
  // answer as soon as the first token lands.
  const view = createAnswerView(question);
  const startedAt = Date.now();
  let streamedText = '';
  let waitingNote = '';

  const renderWaiting = () => {
    if (streamedText) return;
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const note = waitingNote || `Waiting for ${modelLabel(state.model)}`;
    view.body.innerHTML =
      `<span class="waiting">${escapeHtml(note)}… ${seconds}s — press Stop or Esc to cancel</span>`;
  };
  renderWaiting();
  const waitTicker = setInterval(renderWaiting, 1000);

  const removeRetryListener = window.electronAPI.onNvidiaChatRetry(
    ({ requestId: retryRequestId, attempt, of, status }) => {
      if (retryRequestId !== requestId) return;
      waitingNote = status
        ? `${state.model} returned HTTP ${status}, retrying (${attempt + 1}/${of})`
        : `No response, retrying (${attempt + 1}/${of})`;
      renderWaiting();
    },
  );

  const removeChunkListener = state.streamResponses
    ? window.electronAPI.onNvidiaChatChunk(({ requestId: chunkRequestId, delta }) => {
        if (chunkRequestId !== requestId) return;
        streamedText += delta;
        view.body.innerHTML = formatMarkdown(streamedText);
        if (state.autoScroll) el.answerBox.scrollTop = el.answerBox.scrollHeight;
      })
    : () => {};

  let hadError = false;
  try {
    const result = await window.electronAPI.nvidiaChat({
      apiKey: state.apiKey,
      model: state.model,
      messages,
      answerStyle: state.answerStyle,
      enableThinking: state.enableThinking,
      stream: state.streamResponses,
      requestId,
    });

    // Expected API failures come back as data rather than a rejection; routed
    // through the same catch so there is one error path.
    if (result?.error) throw new Error(result.error);

    const answer = result?.choices?.[0]?.message?.content || '';

    if (result?.aborted) {
      handleInterruptedAnswer(answer, question, view, 'stopped');
    } else if (result?.truncated) {
      handleInterruptedAnswer(answer, question, view, 'truncated');
    } else {
      const text = answer || '[Empty response]';
      view.body.innerHTML = formatMarkdown(text);
      recordAnswer(text, question);
      addTranscriptEntry(`[AI] ${text.substring(0, 120)}…`, 'ai');
    }
  } catch (err) {
    hadError = true;
    view.chunk.remove();
    appendAnswer(`⚠ ${cleanIpcError(err.message)}`, question);
    setStatus('error');
    setTimeout(() => setStatus(state.isListening ? 'listening' : 'idle'), 3000);
  } finally {
    clearInterval(waitTicker);
    removeChunkListener();
    removeRetryListener();
    state.pendingRequests.delete(requestId);
    updateAskBusyUI();
    // Only the last request to finish resets the shared status dot, and a failed
    // one keeps its error state until its own timer clears it.
    if (!hadError && state.pendingRequests.size === 0) {
      setStatus(state.isListening ? 'listening' : 'idle');
    }
  }
}

function buildSystemPrompt() {
  const { role, yoe, resume, notes } = state.context;
  const styleGuide = {
    concise:  'Give a concise, bullet-pointed answer. 3-5 bullets max. Be direct.',
    detailed: 'Give a thorough explanation with examples. Use clear sections.',
    code:     'Lead with working code. Add brief explanation after. Use modern syntax.',
    star:     'Structure your answer in STAR format (Situation, Task, Action, Result).',
  }[state.answerStyle] || 'Be concise and clear.';

  let ctx = '';
  if (role)   ctx += `\nCandidate is interviewing for: ${role}`;
  if (yoe)    ctx += `\nYears of experience: ${yoe}`;
  if (resume) ctx += `\n\nResume/Background:\n${resume.substring(0, 2000)}`;
  if (notes)  ctx += `\n\nAdditional context:\n${notes.substring(0, 1000)}`;

  return `You are a real-time interview assistant helping a candidate answer interview questions.
${ctx}

Answer style: ${styleGuide}

Rules:
- Answer as if YOU are the candidate (first-person perspective when needed)
- Match experience level to the role and years stated
- Be accurate and professional
- Keep answers focused and interview-appropriate
- Do not mention you are an AI or assistant`;
}

// ─── Answer display ───────────────────────────────────────────────────────────
function appendAnswer(text, question) {
  const { body } = createAnswerView(question);
  body.innerHTML = formatMarkdown(text);
  recordAnswer(text, question);
}

function createAnswerView(question) {
  el.answerBox.querySelector('.placeholder')?.remove();

  const chunk = document.createElement('div');
  chunk.className = 'answer-chunk';

  const qLabel = document.createElement('div');
  qLabel.className = 'q-label';
  qLabel.textContent = `Q: ${question.substring(0, 80)}${question.length > 80 ? '…' : ''}`;

  const body = document.createElement('div');

  chunk.appendChild(qLabel);
  chunk.appendChild(body);
  el.answerBox.appendChild(chunk);

  return { chunk, body };
}

function recordAnswer(text, question) {
  state.answers.push({ q: question, a: text, ts: new Date().toISOString() });

  if (state.autoScroll) {
    el.answerBox.scrollTop = el.answerBox.scrollHeight;
  }
}

// Lightweight markdown → HTML
function formatMarkdown(text) {
  let h = escapeHtml(text);
  h = h.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  h = h.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  h = h.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  h = h.replace(/\n/g, '<br>');
  return h;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Transcript ───────────────────────────────────────────────────────────────
function addTranscriptEntry(text, source) {
  state.transcript.push({ text, source, ts: new Date() });

  const entry = document.createElement('div');
  entry.className = 'transcript-entry';

  const time = document.createElement('div');
  time.className = 'ts-time';
  time.textContent = new Date().toLocaleTimeString();

  const src = document.createElement('div');
  src.className = 'ts-source';
  src.textContent = source.toUpperCase();

  const body = document.createElement('div');
  body.className = 'ts-text';
  body.textContent = text.substring(0, 300);

  entry.appendChild(time);
  entry.appendChild(src);
  entry.appendChild(body);
  el.transcriptBox.appendChild(entry);
  el.transcriptBox.scrollTop = el.transcriptBox.scrollHeight;
}

// ─── Clear buttons ────────────────────────────────────────────────────────────
function setupClearButtons() {
  $('btn-clear-heard').addEventListener('click', () => {
    el.heardBox.innerHTML = '<p class="placeholder">Listening for questions…</p>';
  });
  $('btn-clear-answer').addEventListener('click', () => {
    el.answerBox.innerHTML = '<p class="placeholder">AI response will appear here…</p>';
    state.answers = [];
  });
  $('btn-copy').addEventListener('click', async () => {
    const text = state.answers.map(a => `Q: ${a.q}\nA: ${a.a}`).join('\n\n---\n\n');
    await navigator.clipboard.writeText(text).catch(() => {});
  });
  $('btn-clear-transcript').addEventListener('click', () => {
    el.transcriptBox.innerHTML = '';
    state.transcript = [];
  });

  el.toggleAutoscroll.addEventListener('change', () => {
    state.autoScroll = el.toggleAutoscroll.checked;
  });
}

// ─── Context tab ──────────────────────────────────────────────────────────────
function setupContextTab() {
  [el.ctxRole, el.ctxYoe, el.ctxResume, el.ctxNotes].forEach(inp => {
    inp.addEventListener('input', () => syncContextFromFields());
  });

  el.btnUploadFile.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    el.uploadStatus.textContent = 'Reading…';
    try {
      const text = await window.electronAPI.readFile(file.path);
      el.ctxResume.value = text;
      el.uploadStatus.textContent = `✓ Loaded: ${file.name}`;
      syncContextFromFields();
    } catch (err) {
      el.uploadStatus.textContent = `✗ Error: ${err.message}`;
    }
    e.target.value = '';
  });

  el.btnSaveContext.addEventListener('click', async () => {
    syncContextFromFields();
    await window.electronAPI.saveContext({
      ...state.context,
      apiKey: state.apiKey,
      model: state.model,
      language: state.language,
      answerStyle: state.answerStyle,
      enableThinking: state.enableThinking,
      streamResponses: state.streamResponses,
    });
    el.saveStatus.textContent = '✓ Saved';
    setTimeout(() => { el.saveStatus.textContent = ''; }, 2000);
  });
}

function syncContextFromFields() {
  state.context.role   = el.ctxRole.value.trim();
  state.context.yoe    = el.ctxYoe.value.trim();
  state.context.resume = el.ctxResume.value.trim();
  state.context.notes  = el.ctxNotes.value.trim();
}

// ─── Settings tab ─────────────────────────────────────────────────────────────
function setupSettingsTab() {
  el.setOpacity.addEventListener('input', () => {
    const v = +el.setOpacity.value;
    el.opacityLabel.textContent = `${v}%`;
    applyOpacity(v);
  });

  el.btnShowKey.addEventListener('click', () => {
    el.setApikey.type = el.setApikey.type === 'password' ? 'text' : 'password';
  });

  el.btnApplySize.addEventListener('click', () => {
    window.electronAPI.resizeWindow({
      width:  +el.setWidth.value,
      height: +el.setHeight.value,
    });
  });

  el.setApikey.addEventListener('input',  () => { state.apiKey = el.setApikey.value.trim(); });
  el.setModel.addEventListener('change',  () => { state.model  = el.setModel.value; });
  el.btnAddModel.addEventListener('click', () => toggleAddModelRow());
  el.btnConfirmModel.addEventListener('click', confirmAddModel);
  el.btnCancelModel.addEventListener('click', () => toggleAddModelRow(false));
  el.newModelId.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmAddModel();
    } else if (e.key === 'Escape') {
      // Kept off the window-level Escape handler, which is for cancelling a
      // running AI request.
      e.preventDefault();
      e.stopPropagation();
      toggleAddModelRow(false);
    }
  });
  el.btnRefreshModels.addEventListener('click', refreshModelStatuses);
  el.setLanguage.addEventListener('change', () => {
    state.language = el.setLanguage.value;
    // Restart recognition with new language
    if (state.isListening) {
      stopListening();
      setTimeout(startListening, 500);
    }
  });
  el.setStyle.addEventListener('change', () => { state.answerStyle = el.setStyle.value; });

  el.setSttEngine.addEventListener('change', () => {
    readSttSettingsFromFields();
    persistSttSettings();
    renderSttSettings();
    // Switching engines mid-session means the running one is now wrong.
    if (state.isListening) restartListening();
  });
  [el.setSttCloudKey, el.setSttCloudUrl, el.setSttCloudModel].forEach(input => {
    input.addEventListener('input', () => {
      readSttSettingsFromFields();
      el.sttEngineHint.textContent = (() => {
        const { engine, notice } = resolveSttEngine();
        return notice ? `⚠ ${notice}` : STT_ENGINE_HINTS[engine] || '';
      })();
    });
  });
  el.btnShowSttKey.addEventListener('click', () => {
    el.setSttCloudKey.type = el.setSttCloudKey.type === 'password' ? 'text' : 'password';
  });

  el.toggleThinking.addEventListener('change', () => {
    state.enableThinking = el.toggleThinking.checked;
  });
  el.toggleStreaming.addEventListener('change', () => {
    state.streamResponses = el.toggleStreaming.checked;
  });

  el.btnSaveSettings.addEventListener('click', async () => {
    state.apiKey      = el.setApikey.value.trim();
    state.model       = el.setModel.value;
    state.language    = el.setLanguage.value;
    state.answerStyle = el.setStyle.value;
    state.enableThinking = el.toggleThinking.checked;
    state.streamResponses = el.toggleStreaming.checked;
    readSttSettingsFromFields();
    persistSttSettings();
    renderSttSettings();
    localStorage.setItem('ih_settings', JSON.stringify({
      apiKey:      state.apiKey,
      model:       state.model,
      language:    state.language,
      answerStyle: state.answerStyle,
      enableThinking: state.enableThinking,
      streamResponses: state.streamResponses,
      opacity:     el.setOpacity.value,
      width:       el.setWidth.value,
      height:      el.setHeight.value,
    }));
    el.settingsStatus.textContent = '✓ Saved';
    refreshModelStatuses();
    setTimeout(() => { el.settingsStatus.textContent = ''; }, 2000);
  });
  if (state.apiKey) refreshModelStatuses();
}

function loadModelCatalog() {
  try {
    const saved = JSON.parse(localStorage.getItem('ih_models') || 'null');
    state.models = Array.isArray(saved)
      ? [...new Set(saved.filter(id => typeof id === 'string' && MODEL_ID_PATTERN.test(id)))]
      : BUILTIN_MODELS.map(([id]) => id);
  } catch (_) {
    state.models = BUILTIN_MODELS.map(([id]) => id);
  }
  if (!state.models.length) state.models = [DEFAULT_MODEL];
  // New built-ins are appended without restoring models the user removed.
  const catalogVersion = localStorage.getItem('ih_models_version');
  if (catalogVersion !== '2') {
    ['moonshotai/kimi-k3', 'deepseek-ai/deepseek-v4-pro-0813'].forEach(id => {
      if (!state.models.includes(id)) state.models.push(id);
    });
    localStorage.setItem('ih_models_version', '2');
    persistModelCatalog();
  }
  renderModelControls();
}

function persistModelCatalog() {
  localStorage.setItem('ih_models', JSON.stringify(state.models));
}

function modelLabel(id) { return BUILTIN_MODEL_LABELS.get(id) || id; }
function hasConfiguredModel(id) { return state.models.includes(id); }

function renderModelControls() {
  const selected = hasConfiguredModel(state.model) ? state.model : state.models[0];
  el.setModel.innerHTML = '';
  state.models.forEach(id => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = modelLabel(id);
    el.setModel.appendChild(option);
  });
  state.model = selected;
  el.setModel.value = selected;
  el.modelList.innerHTML = '';
  state.models.forEach(id => {
    const row = document.createElement('div');
    row.className = 'model-item';
    const name = document.createElement('span');
    name.className = 'model-item-name';
    name.textContent = modelLabel(id);
    name.title = id;
    const value = state.modelStatuses.get(id) || 'unknown';
    const status = document.createElement('span');
    status.className = `model-status ${value}`;
    status.textContent = { checking: 'Checking…', working: '● Working', unavailable: '● Unavailable', unknown: '○ Unknown' }[value];
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-ghost btn-xs model-remove';
    remove.textContent = '×';
    remove.title = `Remove ${id}`;
    remove.disabled = state.models.length === 1;
    remove.addEventListener('click', () => removeModel(id));
    row.append(name, status, remove);
    el.modelList.appendChild(row);
  });
}

// Electron refuses window.prompt() outright ("prompt() is and will not be
// supported"), which threw out of the click handler and made the + button look
// dead. This is an inline row instead.
function toggleAddModelRow(show) {
  const open = show === undefined ? el.addModelRow.classList.contains('hidden') : show;
  el.addModelRow.classList.toggle('hidden', !open);
  setAddModelHint('');
  if (open) {
    el.newModelId.value = '';
    el.newModelId.focus();
  }
}

function setAddModelHint(message, isError = false) {
  el.addModelHint.textContent = message;
  el.addModelHint.classList.toggle('hidden', !message);
  el.addModelHint.style.color = isError ? 'var(--danger)' : 'var(--accent2)';
}

function confirmAddModel() {
  const id = el.newModelId.value.trim();

  if (!id) {
    setAddModelHint('Enter a model ID, for example meta/llama-3.1-70b-instruct', true);
    return;
  }
  if (!MODEL_ID_PATTERN.test(id)) {
    setAddModelHint(`"${id}" is not a valid ID. Use the provider/model form.`, true);
    return;
  }
  if (state.models.includes(id)) {
    // Already there: select it rather than silently doing nothing.
    state.model = id;
    persistModelCatalog();
    renderModelControls();
    toggleAddModelRow(false);
    setAddModelHint(`${id} was already in the list, and is now selected.`);
    return;
  }

  state.models.push(id);
  state.model = id;
  persistModelCatalog();
  renderModelControls();
  toggleAddModelRow(false);
  setAddModelHint(`Added ${id}.`);
  refreshModelStatuses();
}

function removeModel(id) {
  if (state.models.length === 1) return;
  state.models = state.models.filter(model => model !== id);
  state.modelStatuses.delete(id);
  if (state.model === id) state.model = state.models[0];
  persistModelCatalog();
  renderModelControls();
}

async function refreshModelStatuses() {
  const apiKey = el.setApikey.value.trim() || state.apiKey;
  if (!apiKey) {
    state.modelStatuses.clear();
    renderModelControls();
    el.settingsStatus.textContent = 'Add an API key to check models';
    return;
  }
  state.models.forEach(id => state.modelStatuses.set(id, 'checking'));
  renderModelControls();
  el.btnRefreshModels.disabled = true;
  try {
    const available = new Set(await window.electronAPI.listNvidiaModels(apiKey));
    state.models.forEach(id => state.modelStatuses.set(id, available.has(id) ? 'working' : 'unavailable'));
  } catch (err) {
    state.models.forEach(id => state.modelStatuses.set(id, 'unknown'));
    el.settingsStatus.textContent = `✗ ${cleanIpcError(err.message)}`;
  } finally {
    el.btnRefreshModels.disabled = false;
    renderModelControls();
  }
}

function applyOpacity(pct) {
  document.getElementById('app').style.opacity = (pct / 100).toString();
}

// ─── Persist / load ───────────────────────────────────────────────────────────
function loadSettingsFromStorage() {
  try {
    const raw = localStorage.getItem('ih_settings');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.apiKey)      { state.apiKey      = s.apiKey;      el.setApikey.value  = s.apiKey; }
    if (hasConfiguredModel(s.model)) {
      state.model = s.model;
      el.setModel.value = s.model;
    } else {
      state.model = DEFAULT_MODEL;
      el.setModel.value = DEFAULT_MODEL;
    }
    if (s.language)    { state.language    = s.language;    el.setLanguage.value = s.language; }
    if (s.answerStyle) { state.answerStyle = s.answerStyle; el.setStyle.value   = s.answerStyle; }
    state.enableThinking = s.enableThinking === true;
    el.toggleThinking.checked = state.enableThinking;
    state.streamResponses = s.streamResponses !== false;
    el.toggleStreaming.checked = state.streamResponses;
    if (s.opacity)     { el.setOpacity.value = s.opacity; el.opacityLabel.textContent = `${s.opacity}%`; }
    if (s.width)       el.setWidth.value  = s.width;
    if (s.height)      el.setHeight.value = s.height;
  } catch (e) {}
}

async function loadContextFromMain() {
  try {
    const data = await window.electronAPI.loadContext();
    if (!data) return;
    if (data.role)   { state.context.role   = data.role;   el.ctxRole.value   = data.role; }
    if (data.yoe)    { state.context.yoe    = data.yoe;    el.ctxYoe.value    = data.yoe; }
    if (data.resume) { state.context.resume = data.resume; el.ctxResume.value = data.resume; }
    if (data.notes)  { state.context.notes  = data.notes;  el.ctxNotes.value  = data.notes; }
    if (data.apiKey && !state.apiKey) { state.apiKey = data.apiKey; el.setApikey.value = data.apiKey; }
    if (hasConfiguredModel(data.model)) {
      state.model = data.model;
      el.setModel.value = data.model;
    }
    if (typeof data.enableThinking === 'boolean' && !localStorage.getItem('ih_settings')) {
      state.enableThinking = data.enableThinking;
      el.toggleThinking.checked = data.enableThinking;
    }
    if (typeof data.streamResponses === 'boolean' && !localStorage.getItem('ih_settings')) {
      state.streamResponses = data.streamResponses;
      el.toggleStreaming.checked = data.streamResponses;
    }
  } catch (e) {}
}

// ─── Status dot ───────────────────────────────────────────────────────────────
function setStatus(s) {
  el.statusDot.className = `status-dot ${s}`;
}

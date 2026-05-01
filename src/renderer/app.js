/* ═══════════════════════════════════════════════════════
  ghost — Renderer Logic
   Handles: drag, tabs, STT, NVIDIA API, context, settings
════════════════════════════════════════════════════════ */

'use strict';

const Vosk = window.Vosk;

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  isListening: false,
  activeSource: null,
  audioStream: null,
  audioCtx: null,
  analyser: null,
  sourceNode: null,
  recognizer: null,
  sttPollTimer: null,
  sttModel: null,
  sttModelPromise: null,
  sttModelUrl: null,
  runtimeInfo: null,
  autoScroll: true,
  apiKey: '',
  model: 'openai/gpt-oss-120b',
  language: 'en-US',
  answerStyle: 'concise',
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
  setLanguage:      $('set-language'),
  setStyle:         $('set-style'),
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
  loadSettingsFromStorage();
  await loadContextFromMain();
  setupTabs();
  setupTitlebar();
  setupResize();
  setupAudioControls();
  setupManualAsk();
  setupContextTab();
  setupSettingsTab();
  setupClearButtons();
  applyOpacity(+el.setOpacity.value);

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

  el.toggleMic.addEventListener('change', handleSourceToggleChange);
  el.toggleSpeaker.addEventListener('change', handleSourceToggleChange);
}

function handleSourceToggleChange() {
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

async function ensureSttModel() {
  if (state.sttModel) return state.sttModel;
  if (state.sttModelPromise) return state.sttModelPromise;
  if (!Vosk?.createModel) throw new Error('Vosk library failed to load.');

  state.sttModelPromise = (async () => {
    state.runtimeInfo = await window.electronAPI.getRuntimeInfo();
    state.sttModelUrl = await window.electronAPI.getModelPath();
    state.sttModel = await Vosk.createModel(state.sttModelUrl);
    return state.sttModel;
  })();

  try {
    return await state.sttModelPromise;
  } catch (err) {
    state.sttModelPromise = null;
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

    return navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });
  }

  if (window.electronAPI?.platform === 'darwin') {
    const granted = await window.electronAPI.requestMicrophonePermission().catch(() => false);
    if (!granted) {
      throw new Error('Microphone access denied. Go to System Settings > Privacy & Security > Microphone and allow this app.');
    }
  }

  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1,
    },
    video: false,
  });
}

// ─── Start listening (Vosk live STT) ────────────────────────────────────────
async function startListening() {
  if (state.isListening) return;
  const sourceType = getSelectedSourceType();
  if (!sourceType) {
    showInHeard('Enable Mic or Speaker to start speech-to-text.');
    setStatus('idle');
    return;
  }

  try {
    if (sourceType === 'mic' && el.toggleSpeaker.checked) {
      showInHeard('Mic and Speaker are both enabled. Using Mic capture.');
    }

    if (!state.language.startsWith('en')) {
      showInHeard('Current STT model is English-only. Using the bundled English model.');
    }

    const model = await ensureSttModel();
    const stream = await getInputStream(sourceType);
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();

    const recognizer = new model.KaldiRecognizer(audioCtx.sampleRate);
    recognizer.setWords(true);

    recognizer.on('partialresult', (message) => {
      const text = message?.result?.partial?.trim();
      if (text && state.isListening) updateInterimHeard(text);
    });

    recognizer.on('result', (message) => {
      const text = message?.result?.text?.trim();
      if (!text || !state.isListening) return;
      addTranscriptEntry(text, sourceType);
      showInHeard(text);
      if (el.toggleAuto.checked) askAI(text);
    });

    const sourceNode = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    sourceNode.connect(analyser);

    const pcmBuffer = new Float32Array(analyser.fftSize);

    state.audioStream = stream;
    state.audioCtx = audioCtx;
    state.sourceNode = sourceNode;
    state.analyser = analyser;
    state.recognizer = recognizer;
    state.activeSource = sourceType;
    state.isListening = true;
    state.sttPollTimer = window.setInterval(() => {
      if (!state.recognizer || !state.analyser) return;
      try {
        state.analyser.getFloatTimeDomainData(pcmBuffer);
        state.recognizer.acceptWaveformFloat(pcmBuffer, state.audioCtx.sampleRate);
      } catch (pollErr) {
        console.error('[STT] acceptWaveform error:', pollErr);
      }
    }, 100);

    setListenUI(true);
    setStatus('listening');
  } catch (err) {
    console.error('[STT] startListening error:', err);
    forceStopListening();
    showInHeard(`⚠ ${err.message}`);
    setStatus('error');
  }
}

// ─── Stop listening ───────────────────────────────────────────────────────────
function stopListening() {
  if (!state.isListening) return;
  forceStopListening();
}

function forceStopListening() {
  state.isListening = false;
  state.activeSource = null;

  clearInterval(state.sttPollTimer);
  state.sttPollTimer = null;

  if (state.sourceNode) {
    try { state.sourceNode.disconnect(); } catch (_) {}
  }
  state.sourceNode = null;

  if (state.recognizer) {
    try { state.recognizer.remove(); } catch (_) {}
  }
  state.recognizer = null;

  if (state.audioCtx) {
    try { state.audioCtx.close(); } catch (_) {}
    state.audioCtx = null;
    state.analyser = null;
  }

  if (state.audioStream) {
    state.audioStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
    state.audioStream = null;
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
}

// ─── NVIDIA AI call ───────────────────────────────────────────────────────────
async function askAI(question) {
  if (!state.apiKey) {
    appendAnswer('⚠ No NVIDIA API key set. Please add it in the Settings tab.', question);
    return;
  }

  setStatus('processing');
  el.loadingBar.classList.remove('hidden');
  el.btnAsk.disabled = true;

  const systemPrompt = buildSystemPrompt();
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question },
  ];

  try {
    const result = await window.electronAPI.nvidiaChat({
      apiKey: state.apiKey,
      model: state.model,
      messages,
    });

    const answer = result?.choices?.[0]?.message?.content || '[Empty response]';
    appendAnswer(answer, question);
    addTranscriptEntry(`[AI] ${answer.substring(0, 120)}…`, 'ai');
  } catch (err) {
    appendAnswer(`⚠ API Error: ${err.message}`, question);
    setStatus('error');
    setTimeout(() => setStatus(state.isListening ? 'listening' : 'idle'), 3000);
  } finally {
    el.loadingBar.classList.add('hidden');
    el.btnAsk.disabled = false;
    if (state.isListening) setStatus('listening');
    else setStatus('idle');
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
  el.answerBox.querySelector('.placeholder')?.remove();

  const chunk = document.createElement('div');
  chunk.className = 'answer-chunk';

  const qLabel = document.createElement('div');
  qLabel.className = 'q-label';
  qLabel.textContent = `Q: ${question.substring(0, 80)}${question.length > 80 ? '…' : ''}`;

  const body = document.createElement('div');
  body.innerHTML = formatMarkdown(text);

  chunk.appendChild(qLabel);
  chunk.appendChild(body);
  el.answerBox.appendChild(chunk);

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
  el.setLanguage.addEventListener('change', () => {
    state.language = el.setLanguage.value;
    // Restart recognition with new language
    if (state.isListening) {
      stopListening();
      setTimeout(startListening, 500);
    }
  });
  el.setStyle.addEventListener('change', () => { state.answerStyle = el.setStyle.value; });

  el.btnSaveSettings.addEventListener('click', async () => {
    state.apiKey      = el.setApikey.value.trim();
    state.model       = el.setModel.value;
    state.language    = el.setLanguage.value;
    state.answerStyle = el.setStyle.value;
    localStorage.setItem('ih_settings', JSON.stringify({
      apiKey:      state.apiKey,
      model:       state.model,
      language:    state.language,
      answerStyle: state.answerStyle,
      opacity:     el.setOpacity.value,
      width:       el.setWidth.value,
      height:      el.setHeight.value,
    }));
    el.settingsStatus.textContent = '✓ Saved';
    setTimeout(() => { el.settingsStatus.textContent = ''; }, 2000);
  });
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
    if (s.model)       { state.model       = s.model;       el.setModel.value   = s.model; }
    if (s.language)    { state.language    = s.language;    el.setLanguage.value = s.language; }
    if (s.answerStyle) { state.answerStyle = s.answerStyle; el.setStyle.value   = s.answerStyle; }
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
    if (data.model)  { state.model = data.model; el.setModel.value = data.model; }
  } catch (e) {}
}

// ─── Status dot ───────────────────────────────────────────────────────────────
function setStatus(s) {
  el.statusDot.className = `status-dot ${s}`;
}

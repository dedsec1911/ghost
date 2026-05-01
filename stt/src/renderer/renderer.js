/* global navigator, window */

const Vosk = window.Vosk

let model = null
let recognizer = null
let audioContext = null
let mediaStream = null
let sourceNode = null
let analyserNode = null
let pollTimer = null
let isRunning = false
let modelPath = null
let runtimeInfo = null

const out = document.getElementById('output')
const warningEl = document.getElementById('warning')
const radios = document.querySelectorAll('input[name="src"]')
const speakerRadio = document.querySelector('input[name="src"][value="speaker"]')

window.addEventListener('error', (event) => {
  console.error('[RENDERER] uncaught error:', event.error || event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[RENDERER] unhandled rejection:', event.reason)
})

function showWarning(msg) {
  warningEl.textContent = msg
  warningEl.style.display = 'block'
}

function hideWarning() {
  warningEl.style.display = 'none'
}

async function getMicStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1
    },
    video: false
  })
}

async function getDesktopAudioStream() {
  return navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true
  })
}

function getSpeakerUnsupportedMessage() {
  return 'System speaker capture is not available in development on macOS 14+ when the app is launched from Terminal or VS Code. Build and run the packaged app so it has its own Info.plist with audio-capture usage strings, or use a virtual loopback device such as BlackHole and select it as microphone input.'
}

function updateRuntimeUI() {
  if (!speakerRadio) {
    return
  }

  const speakerUnsupported = runtimeInfo?.platform === 'darwin' && !runtimeInfo?.isPackaged
  speakerRadio.disabled = speakerUnsupported

  if (speakerUnsupported) {
    speakerRadio.title = getSpeakerUnsupportedMessage()
    showWarning(getSpeakerUnsupportedMessage())
  } else {
    speakerRadio.title = ''
  }
}

async function loadModel() {
  out.value = 'Loading Vosk model…'
  try {
    runtimeInfo = await window.electronAPI.getRuntimeInfo()
    updateRuntimeUI()
    modelPath = await window.electronAPI.getModelPath()
    console.log('[RENDERER] Model blob URL:', modelPath)
    model = await Vosk.createModel(modelPath)
    console.log('[RENDERER] Model ready:', model.ready)

    out.value = 'Model loaded. Select an available input and click to start recording.\n'
    if (!(runtimeInfo?.platform === 'darwin' && !runtimeInfo?.isPackaged)) {
      hideWarning()
    }
  } catch (e) {
    console.error('[RENDERER] Error loading model:', e.message, e.stack)
    showWarning(`Error loading model: ${e.message}`)
    out.value = `Model loading failed: ${e.message}`
  }
}

async function startRecording(sourceType) {
  console.log('[RENDERER] startRecording called with:', sourceType)
  if (isRunning) {
    console.warn('[RENDERER] Already recording')
    return
  }
  if (!model) {
    console.warn('[RENDERER] Model not initialized')
    showWarning('Model not loaded yet.')
    return
  }

  try {
    isRunning = true
    out.value += `\n--- Recording from ${sourceType} ---\n`
    console.log('[RENDERER] Getting audio stream...')
    hideWarning()

    // Get audio stream
    if (sourceType === 'mic') {
      console.log('[RENDERER] Requesting microphone...')
      mediaStream = await getMicStream()
    } else {
      if (runtimeInfo?.platform === 'darwin' && !runtimeInfo?.isPackaged) {
        throw new Error(getSpeakerUnsupportedMessage())
      }

      console.log('[RENDERER] Requesting desktop audio...')
      mediaStream = await getDesktopAudioStream()
    }

    if (!(mediaStream instanceof MediaStream)) {
      throw new Error('Audio capture did not return a MediaStream')
    }

    console.log('[RENDERER] Audio stream obtained, setting up Web Audio API...')

    // Setup Web Audio API
    audioContext = new (window.AudioContext || window.webkitAudioContext)()
    await audioContext.resume()
    recognizer = new model.KaldiRecognizer(audioContext.sampleRate)
    recognizer.setWords(true)

    recognizer.on('result', (message) => {
      try {
        if (message.result && message.result.text) {
          out.value += message.result.text + '\n'
        }
      } catch (error) {
        console.error('[RENDERER] Error processing result:', error)
      }
    })

    recognizer.on('partialresult', (message) => {
      try {
        if (message.result && message.result.partial) {
          const lines = out.value.split('\n')
          lines[lines.length - 2] = message.result.partial
          out.value = lines.join('\n')
        }
      } catch (error) {
        console.error('[RENDERER] Error processing partial result:', error)
      }
    })

    sourceNode = audioContext.createMediaStreamSource(mediaStream)
    analyserNode = audioContext.createAnalyser()
    analyserNode.fftSize = 4096
    analyserNode.smoothingTimeConstant = 0
    sourceNode.connect(analyserNode)

    const pcmBuffer = new Float32Array(analyserNode.fftSize)
    pollTimer = window.setInterval(() => {
      if (!recognizer || !analyserNode) {
        return
      }

      try {
        analyserNode.getFloatTimeDomainData(pcmBuffer)
        recognizer.acceptWaveformFloat(new Float32Array(pcmBuffer), audioContext.sampleRate)
      } catch (e) {
        console.error('[RENDERER] acceptWaveform error:', e)
      }
    }, 100)

    console.log('[RENDERER] Recording started')
  } catch (e) {
    console.error('[RENDERER] Recording error:', e.name, e.message)
    showWarning(`Recording error: ${e.message}`)
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop())
      mediaStream = null
    }
    isRunning = false
  }
}

function stopRecording() {
  if (!isRunning) return
  isRunning = false
  if (sourceNode) sourceNode.disconnect()
  if (pollTimer) window.clearInterval(pollTimer)
  if (recognizer) {
    recognizer.remove()
    recognizer = null
  }
  pollTimer = null
  analyserNode = null
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop())
  }
  mediaStream = null
  sourceNode = null
  out.value += '--- Recording stopped ---\n'
}

// ---- Event listeners ---
document.addEventListener('DOMContentLoaded', () => {
  console.log('[RENDERER] DOMContentLoaded event fired')
  console.log('[RENDERER] Output element:', out)
  console.log('[RENDERER] Radio buttons found:', radios.length)
  
  loadModel()

  radios.forEach(radio => {
    console.log('[RENDERER] Setting up radio button:', radio.value)
    radio.addEventListener('change', (e) => {
      console.log('[RENDERER] Radio button changed:', e.target.value, 'checked:', e.target.checked)
      if (e.target.checked) {
        const sourceType = e.target.value
        if (isRunning) stopRecording()
        startRecording(sourceType)
      }
    })
  })

  // Stop on window close
  window.addEventListener('beforeunload', () => {
    console.log('[RENDERER] Window closing...')
    if (isRunning) stopRecording()
  })
})

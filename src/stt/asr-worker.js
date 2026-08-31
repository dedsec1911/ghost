'use strict';

// Standalone recognizer process.
//
// Runs outside the Electron main process for three reasons:
//   1. sherpa-onnx loads native shared libraries that need DYLD_LIBRARY_PATH /
//      LD_LIBRARY_PATH set before the process starts, which cannot be done from
//      inside an already-running process.
//   2. A crash in the native addon takes down this process only, not the app.
//   3. Decoding is CPU-heavy and would otherwise compete with the UI thread.
//
// Protocol
//   parent -> child  control : JSON over the fork() IPC channel
//   parent -> child  audio   : raw host-endian Float32 PCM, mono, on stdin
//   child  -> parent events  : JSON over the fork() IPC channel

const os = require('os');

let sherpa = null;
let vad = null;
let buffer = null;
let resampler = null;
let recognizer = null;

let engine = 'parakeet';
let inputSampleRate = 0;

// Silero at 16 kHz expects exactly 512-sample windows. Both values are read
// back from the config this module builds rather than from the Vad instance, so
// the framing cannot silently disagree with what the model was given.
const VAD_SAMPLE_RATE = 16000;
const VAD_WINDOW_SIZE = 512;

// Shortest segment worth decoding. Real segments are at least
// minSpeechDuration long, so this only rejects degenerate ones.
const MIN_SEGMENT_SAMPLES = Math.round(0.2 * VAD_SAMPLE_RATE);

// Silero reports a segment start slightly after voicing actually begins, which
// clips the first phoneme -- and with it, often the whole first word. Re-attach
// the audio immediately before the reported start so the encoder sees the onset.
const PRE_ROLL_SAMPLES = Math.round(0.3 * VAD_SAMPLE_RATE);

// Longest utterance held before a cut is forced.
//
// sileroVad.maxSpeechDuration is passed to the VAD as well, but it is not
// honoured when speech never stops: feeding 90 s of gapless speech yields zero
// segments and the VAD's internal buffer keeps growing. So the cut is also
// enforced here. Without it, a long monologue -- or steady noise the VAD scores
// as speech -- produces no transcript at all.
const MAX_SPEECH_SECONDS = 15;
const MAX_SPEECH_SAMPLES = MAX_SPEECH_SECONDS * VAD_SAMPLE_RATE;

// A segment is only handed over once it closes, which for a long utterance is up
// to MAX_SPEECH_SECONDS after its start. The history has to still contain the
// audio from before that start, so it is sized to span a whole segment plus the
// pre-roll. ~1.4 MB at 16 kHz.
const HISTORY_SAMPLES = Math.round((MAX_SPEECH_SECONDS + 2) * VAD_SAMPLE_RATE);

// Decodes run one at a time. Two concurrent native decodes on a 0.6B model
// thrash the CPU and make every segment slower than running them in sequence.
let decodeChain = Promise.resolve();
let speechActive = false;
let speechStartedAt = 0;
let segmentIndex = 0;

// Ring buffer of the most recent audio handed to the VAD, used to rebuild the
// pre-roll. `historyWritten` counts every sample ever fed, which is the same
// clock the VAD uses for `segment.start`.
const history = new Float32Array(HISTORY_SAMPLES);
let historyWritten = 0;
let previousSegmentEnd = 0;

// `chunk` must be no longer than HISTORY_SAMPLES; callers feed one VAD window.
function appendHistory(chunk) {
  const at = historyWritten % HISTORY_SAMPLES;
  const firstPart = Math.min(chunk.length, HISTORY_SAMPLES - at);
  history.set(chunk.subarray(0, firstPart), at);
  if (firstPart < chunk.length) history.set(chunk.subarray(firstPart), 0);
  historyWritten += chunk.length;
}

/** @returns {Float32Array|null} null when the range has already been overwritten. */
function readHistory(startAbs, count) {
  const oldest = Math.max(0, historyWritten - HISTORY_SAMPLES);
  if (count <= 0 || startAbs < oldest || startAbs + count > historyWritten) return null;

  const out = new Float32Array(count);
  const at = startAbs % HISTORY_SAMPLES;
  const firstPart = Math.min(count, HISTORY_SAMPLES - at);
  out.set(history.subarray(at, at + firstPart), 0);
  if (firstPart < count) out.set(history.subarray(0, count - firstPart), firstPart);
  return out;
}

function resetHistory() {
  historyWritten = 0;
  previousSegmentEnd = 0;
}

/**
 * Prepends up to PRE_ROLL_SAMPLES of preceding audio to a segment, without
 * reaching back into the previous segment (which would repeat words when a long
 * utterance is cut by maxSpeechDuration).
 * @returns {Float32Array}
 */
function withPreRoll(segment) {
  const samples = segment.samples;
  const start = typeof segment.start === 'number' ? segment.start : -1;
  if (start < 0) return samples;

  const padStart = Math.max(start - PRE_ROLL_SAMPLES, previousSegmentEnd, 0);
  const pad = readHistory(padStart, start - padStart);
  previousSegmentEnd = start + samples.length;
  if (!pad || !pad.length) return samples;

  const out = new Float32Array(pad.length + samples.length);
  out.set(pad, 0);
  out.set(samples, pad.length);
  return out;
}

function emit(message) {
  if (process.connected) process.send(message);
}

function fail(message) {
  emit({ type: 'error', message: String(message && message.message ? message.message : message) });
}

function loadSherpa(modulePath) {
  if (sherpa) return sherpa;
  // The parent resolves the absolute path; a bare specifier would not resolve
  // from app.asar.unpacked in a packaged build.
  sherpa = require(modulePath || 'sherpa-onnx-node');
  return sherpa;
}

function createVad(vadModelPath) {
  const config = {
    sileroVad: {
      model: vadModelPath,
      threshold: 0.5,
      // A question rarely starts with less than a quarter second of voicing,
      // and this keeps keyboard clicks from opening a segment.
      minSpeechDuration: 0.25,
      // Interview turns are short. Waiting longer than this to close a segment
      // adds latency the candidate feels.
      minSilenceDuration: 0.45,
      // Force a cut on long monologues so text still arrives while the
      // interviewer is talking.
      maxSpeechDuration: MAX_SPEECH_SECONDS,
      windowSize: VAD_WINDOW_SIZE,
    },
    sampleRate: VAD_SAMPLE_RATE,
    numThreads: 1,
    debug: false,
  };
  // 60 s of internal history: enough for maxSpeechDuration plus slack.
  return new sherpa.Vad(config, 60);
}

function createRecognizer(model) {
  // Leave a core for the UI and the audio capture thread.
  const threads = Math.max(1, Math.min(4, os.cpus().length - 2));
  return new sherpa.OfflineRecognizer({
    featConfig: {
      sampleRate: 16000,
      featureDim: 80,
    },
    modelConfig: {
      transducer: {
        encoder: model.encoder,
        decoder: model.decoder,
        joiner: model.joiner,
      },
      tokens: model.tokens,
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
      modelType: 'nemo_transducer',
    },
  });
}

function rebuildResampler() {
  resampler = null;
  if (!inputSampleRate || inputSampleRate === VAD_SAMPLE_RATE) return;
  resampler = new sherpa.LinearResampler(inputSampleRate, VAD_SAMPLE_RATE);
}

// Drops queued segments and returns the detector to its starting state. Used on
// a sample-rate change and when capture goes idle, where any partially observed
// utterance is stale.
function resetVad() {
  if (!vad) return;
  try { if (typeof vad.reset === 'function') vad.reset(); } catch (_) {}
  try { if (typeof vad.clear === 'function') vad.clear(); } catch (_) {}
  speechActive = false;
  speechStartedAt = 0;
  // The VAD's sample clock restarts, so the pre-roll history must too.
  resetHistory();
}

function init(options) {
  loadSherpa(options.sherpaModule);

  engine = options.engine === 'cloud' ? 'cloud' : 'parakeet';
  vad = createVad(options.vadModel);
  // 30 s of pending capture, drained in VAD_WINDOW_SIZE chunks per stdin read.
  buffer = new sherpa.CircularBuffer(30 * VAD_SAMPLE_RATE);

  if (engine === 'parakeet') {
    recognizer = createRecognizer(options.parakeet);
  }

  inputSampleRate = options.inputSampleRate || 0;
  rebuildResampler();

  emit({ type: 'ready', engine });
}

// Float32 -> 16-bit PCM. Used only for the cloud engine, where the segment has
// to leave the process as bytes.
function toPcm16Base64(samples) {
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return out.toString('base64');
}

function handleSegment(rawSegment) {
  // A zero-length segment reaches the encoder as a {0, 128} tensor, which
  // onnxruntime rejects outright, so it is dropped here instead.
  if (!rawSegment || !rawSegment.samples || rawSegment.samples.length < MIN_SEGMENT_SAMPLES) return;

  const index = segmentIndex++;
  const samples = withPreRoll(rawSegment);
  const durationSeconds = samples.length / VAD_SAMPLE_RATE;

  if (engine === 'cloud') {
    emit({
      type: 'segment',
      index,
      durationSeconds,
      sampleRate: VAD_SAMPLE_RATE,
      pcm16: toPcm16Base64(samples),
    });
    return;
  }

  decodeChain = decodeChain
    .then(async () => {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: VAD_SAMPLE_RATE });
      await recognizer.decodeAsync(stream);
      const result = recognizer.getResult(stream);
      const text = (result.text || '').trim();
      if (text) emit({ type: 'text', index, text, durationSeconds });
    })
    .catch((err) => fail(err));
}

function drainVad() {
  const nowActive = vad.isDetected();
  if (nowActive !== speechActive) {
    speechActive = nowActive;
    if (nowActive) speechStartedAt = historyWritten;
    emit({ type: 'speech', active: speechActive });
  }

  // Watchdog cut: flush() releases the utterance buffered so far as a segment,
  // so text keeps arriving while someone is still talking.
  if (speechActive && historyWritten - speechStartedAt >= MAX_SPEECH_SAMPLES) {
    vad.flush();
    speechStartedAt = historyWritten;
  }

  while (!vad.isEmpty()) {
    // enableExternalBuffer must be false. Electron's V8 sandbox rejects external
    // ArrayBuffers outright ("External buffers are not allowed"), and a copy is
    // required here anyway because the samples outlive the pop() below.
    const segment = vad.front(false);
    vad.pop();
    handleSegment(segment);
  }
}

function pushSamples(samples) {
  if (!vad || !buffer) return;
  // The renderer sends the capture rate as a separate control message. Until it
  // arrives the resampler ratio is unknown, so audio would be misinterpreted.
  if (!inputSampleRate) return;
  const resampled = resampler ? resampler.resample(samples) : samples;
  if (!resampled.length) return;

  buffer.push(resampled);
  while (buffer.size() >= VAD_WINDOW_SIZE) {
    // enableExternalBuffer = false: see the note in drainVad().
    const window = buffer.get(buffer.head(), VAD_WINDOW_SIZE, false);
    buffer.pop(VAD_WINDOW_SIZE);
    // Recorded before handing it over, so the sample clock here matches the
    // VAD's and `segment.start` can be used to index back into it.
    appendHistory(window);
    vad.acceptWaveform(window);
  }
  drainVad();
}

// stdin chunks do not respect sample boundaries, so carry the tail bytes over.
let pending = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  try {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const usable = pending.length - (pending.length % 4);
    if (usable === 0) return;

    // Buffer.concat may hand back a view whose byteOffset is not 4-aligned,
    // which Float32Array cannot wrap. Copy in that case.
    const head = pending.subarray(0, usable);
    const aligned = head.byteOffset % 4 === 0 ? head : Buffer.from(head);
    const samples = new Float32Array(
      aligned.buffer,
      aligned.byteOffset,
      usable / 4,
    );

    pending = pending.subarray(usable);
    pushSamples(samples);
  } catch (err) {
    fail(err);
  }
});

process.on('message', (message) => {
  try {
    switch (message && message.type) {
      case 'init':
        init(message);
        break;

      case 'set-input-rate':
        if (message.sampleRate !== inputSampleRate) {
          inputSampleRate = message.sampleRate;
          rebuildResampler();
          // Bytes already buffered were captured at the old rate.
          pending = Buffer.alloc(0);
          if (buffer) buffer.reset();
          resetVad();
        }
        break;

      // Called when capture stops so a half-finished utterance is still
      // transcribed instead of being silently dropped. Flushing while no
      // utterance is in progress makes the native VAD emit a zero-length
      // segment and log an internal buffer error, so it is gated on isDetected.
      case 'flush':
        if (vad) {
          if (vad.isDetected()) vad.flush();
          drainVad();
        }
        break;

      case 'reset':
        pending = Buffer.alloc(0);
        if (buffer) buffer.reset();
        resetVad();
        break;

      case 'shutdown':
        process.exit(0);
        break;

      default:
        break;
    }
  } catch (err) {
    fail(err);
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('disconnect', () => process.exit(0));

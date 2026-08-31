'use strict';

// Sample-exact microphone / speaker capture.
//
// The previous implementation polled an AnalyserNode on a setInterval and fed
// whatever `getFloatTimeDomainData` happened to hold to the recognizer. That
// call always returns the most recent fftSize samples, so any timer jitter --
// which is constant in a renderer that is also streaming an API response and
// re-rendering markdown -- silently skipped or duplicated audio. The recognizer
// received a spliced, discontinuous waveform, which is the main reason
// transcripts came out garbled.
//
// This module instead consumes every frame the capture device produces:
//   * MediaStreamTrackProcessor when available (raw AudioData frames, no
//     WebAudio graph and no output device at all), or
//   * an AudioWorklet, whose process() callback is driven by the audio thread
//     rather than by a timer.

const BATCH_SECONDS = 0.1;

/** @returns {boolean} true when the preferred zero-loss capture path exists. */
function hasTrackProcessor() {
  return typeof window.MediaStreamTrackProcessor === 'function';
}

// Reused across frames: at ~100 callbacks per second, allocating here would
// generate enough garbage to cause audible collection pauses.
let planeScratch = new Float32Array(0);
let interleavedF32Scratch = new Float32Array(0);
let interleavedS16Scratch = new Int16Array(0);

function planeBuffer(length) {
  if (planeScratch.length < length) planeScratch = new Float32Array(length);
  return planeScratch;
}

/**
 * Downmixes one AudioData frame to mono Float32 in [-1, 1].
 * @param {AudioData} data
 * @returns {Float32Array} a freshly allocated frame owned by the caller
 */
function toMono(data) {
  const frames = data.numberOfFrames;
  const channels = data.numberOfChannels;
  const out = new Float32Array(frames);

  // Fast path: let the browser handle both the format conversion and the
  // planar split. Chromium implements f32-planar conversion for every input
  // format, but the spec allows it to refuse, so this stays guarded.
  try {
    const plane = planeBuffer(frames);
    for (let ch = 0; ch < channels; ch += 1) {
      data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
      for (let i = 0; i < frames; i += 1) out[i] += plane[i];
    }
    if (channels > 1) {
      for (let i = 0; i < frames; i += 1) out[i] /= channels;
    }
    return out;
  } catch (_) {
    // Fall through to per-format handling below.
  }

  const format = data.format || 'f32';

  if (format === 'f32-planar' || format === 's16-planar') {
    const planar = format === 'f32-planar';
    const plane = planar ? planeBuffer(frames) : new Int16Array(frames);
    for (let ch = 0; ch < channels; ch += 1) {
      data.copyTo(plane, { planeIndex: ch });
      for (let i = 0; i < frames; i += 1) {
        out[i] += planar ? plane[i] : plane[i] / 32768;
      }
    }
  } else if (format === 's16') {
    const total = frames * channels;
    if (interleavedS16Scratch.length < total) interleavedS16Scratch = new Int16Array(total);
    data.copyTo(interleavedS16Scratch, { planeIndex: 0 });
    for (let i = 0; i < frames; i += 1) {
      for (let ch = 0; ch < channels; ch += 1) {
        out[i] += interleavedS16Scratch[i * channels + ch] / 32768;
      }
    }
  } else {
    const total = frames * channels;
    if (interleavedF32Scratch.length < total) interleavedF32Scratch = new Float32Array(total);
    data.copyTo(interleavedF32Scratch, { planeIndex: 0 });
    for (let i = 0; i < frames; i += 1) {
      for (let ch = 0; ch < channels; ch += 1) {
        out[i] += interleavedF32Scratch[i * channels + ch];
      }
    }
  }

  if (channels > 1) {
    for (let i = 0; i < frames; i += 1) out[i] /= channels;
  }
  return out;
}

// Device frames are ~10 ms. Coalescing them into ~100 ms blocks cuts IPC
// message rate by 10x without adding meaningful latency.
function createBatcher(onBatch) {
  let target = 0;
  let queue = [];
  let queued = 0;

  return {
    setSampleRate(rate) {
      target = Math.max(1, Math.round(rate * BATCH_SECONDS));
    },
    push(samples) {
      queue.push(samples);
      queued += samples.length;
      if (queued < target) return;
      const merged = new Float32Array(queued);
      let at = 0;
      for (const chunk of queue) { merged.set(chunk, at); at += chunk.length; }
      queue = [];
      queued = 0;
      onBatch(merged);
    },
    flush() {
      if (!queued) return;
      const merged = new Float32Array(queued);
      let at = 0;
      for (const chunk of queue) { merged.set(chunk, at); at += chunk.length; }
      queue = [];
      queued = 0;
      onBatch(merged);
    },
  };
}

/**
 * Starts capture on the first audio track of `stream`.
 *
 * @param {object} options
 * @param {MediaStream} options.stream
 * @param {(samples: Float32Array) => void} options.onSamples mono, native rate
 * @param {(sampleRate: number) => void} options.onSampleRate fired once known
 * @param {(err: Error) => void} [options.onError]
 * @returns {Promise<{sampleRate: number, mode: string, stop: () => Promise<void>}>}
 */
async function startCapture({ stream, onSamples, onSampleRate, onError = () => {} }) {
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('The selected source produced no audio track.');

  const batcher = createBatcher(onSamples);
  let sampleRate = 0;

  const noteSampleRate = (rate) => {
    if (!rate || rate === sampleRate) return;
    sampleRate = rate;
    batcher.setSampleRate(rate);
    onSampleRate(rate);
  };

  if (hasTrackProcessor()) {
    const processor = new window.MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    let stopped = false;

    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || stopped) break;
          try {
            noteSampleRate(value.sampleRate);
            batcher.push(toMono(value));
          } finally {
            value.close();
          }
        }
      } catch (err) {
        if (!stopped) onError(err);
      }
    })();

    // The track's settings report the negotiated rate before the first frame
    // arrives, which lets the recognizer be configured up front.
    noteSampleRate(track.getSettings().sampleRate || 0);

    return {
      get sampleRate() { return sampleRate; },
      mode: 'track-processor',
      async stop() {
        stopped = true;
        batcher.flush();
        try { await reader.cancel(); } catch (_) {}
      },
    };
  }

  // ── Fallback: AudioWorklet ──
  // Note the deliberate avoidance of ScriptProcessorNode: it runs on the main
  // thread and Electron 28 on Intel macOS can crash the renderer when it opens
  // that node's output device. An AudioWorklet runs on the audio thread.
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
  await audioCtx.resume();
  await audioCtx.audioWorklet.addModule('pcm-worklet.js');

  noteSampleRate(audioCtx.sampleRate);

  const sourceNode = audioCtx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioCtx, 'pcm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  worklet.port.onmessage = (event) => batcher.push(event.data);

  // A worklet only runs while it is part of the graph that the destination
  // pulls, so a muted tap to the destination is required. Gain 0 keeps the
  // captured audio from being played back into the room.
  const mute = audioCtx.createGain();
  mute.gain.value = 0;

  sourceNode.connect(worklet);
  worklet.connect(mute);
  mute.connect(audioCtx.destination);

  return {
    get sampleRate() { return sampleRate; },
    mode: 'audio-worklet',
    async stop() {
      batcher.flush();
      worklet.port.onmessage = null;
      [sourceNode, worklet, mute].forEach(node => { try { node.disconnect(); } catch (_) {} });
      try { await audioCtx.close(); } catch (_) {}
    },
  };
}

window.ghostAudioCapture = { startCapture, hasTrackProcessor };

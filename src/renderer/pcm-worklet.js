// AudioWorklet fallback used when MediaStreamTrackProcessor is unavailable.
// Runs on the audio thread, so every render quantum is delivered — unlike the
// timer-polled AnalyserNode this replaced.

class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const frames = input[0].length;
    if (frames === 0) return true;

    const mono = new Float32Array(frames);
    if (input.length === 1) {
      mono.set(input[0]);
    } else {
      for (const channel of input) {
        for (let i = 0; i < frames; i += 1) mono[i] += channel[i];
      }
      for (let i = 0; i < frames; i += 1) mono[i] /= input.length;
    }

    this.port.postMessage(mono, [mono.buffer]);
    // Keep the processor alive even while the source is silent.
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);

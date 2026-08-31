const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  dragWindow: (delta) => ipcRenderer.send('window-drag', delta),
  closeWindow: () => ipcRenderer.send('window-close'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  toggleProtection: (on) => ipcRenderer.send('toggle-protection', on),
  resizeWindow: (size) => ipcRenderer.send('window-resize', size),

  // Permissions
  requestMicrophonePermission: () => ipcRenderer.invoke('request-microphone-permission'),
  getRuntimeInfo: () => ipcRenderer.invoke('get-runtime-info'),
  getModelPath: async () => {
    const buffer = await ipcRenderer.invoke('read-model-file');
    const uint8Array = new Uint8Array(buffer);
    const blob = new Blob([uint8Array], { type: 'application/gzip' });
    return URL.createObjectURL(blob);
  },

  // Storage
  saveContext: (data) => ipcRenderer.invoke('save-context', data),
  loadContext: () => ipcRenderer.invoke('load-context'),
  readFile: (path) => ipcRenderer.invoke('read-file', path),

  // Speech-to-text (Parakeet / cloud engines run in the main process)
  stt: {
    capabilities: () => ipcRenderer.invoke('stt-capabilities'),
    start: (options) => ipcRenderer.invoke('stt-start', options),
    stop: () => ipcRenderer.invoke('stt-stop'),
    flush: () => ipcRenderer.invoke('stt-flush'),
    pushAudio: (samples) => ipcRenderer.send('stt-audio', samples),
    setInputSampleRate: (rate) => ipcRenderer.send('stt-input-rate', rate),
    on: (channel, callback) => {
      const allowed = [
        'stt-transcript',
        'stt-speech',
        'stt-status',
        'stt-error',
        'stt-model-progress',
      ];
      if (!allowed.includes(channel)) throw new Error(`Unknown STT channel: ${channel}`);
      const listener = (_, payload) => callback(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  },

  // AI
  nvidiaChat: (opts) => ipcRenderer.invoke('nvidia-chat', opts),
  // Omit requestId to cancel everything that is still running.
  abortNvidiaChat: (requestId) => ipcRenderer.invoke('nvidia-chat-abort', requestId),
  listNvidiaModels: (apiKey) => ipcRenderer.invoke('nvidia-list-models', apiKey),
  onNvidiaChatChunk: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('nvidia-chat-chunk', listener);
    return () => ipcRenderer.removeListener('nvidia-chat-chunk', listener);
  },
  onNvidiaChatRetry: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('nvidia-chat-retry', listener);
    return () => ipcRenderer.removeListener('nvidia-chat-retry', listener);
  },

  // Platform
  platform: process.platform,
});

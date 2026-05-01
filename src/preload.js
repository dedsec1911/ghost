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

  // AI
  nvidiaChat: (opts) => ipcRenderer.invoke('nvidia-chat', opts),

  // Platform
  platform: process.platform,
});

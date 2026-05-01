// src/preload.js
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Get the model path
  getModelPath: async () => {
    try {
      console.log('[PRELOAD] Reading model file from main process...')
      const buffer = await ipcRenderer.invoke('read-model-file')
      console.log('[PRELOAD] Model file read, size:', buffer.length, 'bytes')
      // Convert array back to Uint8Array
      const uint8Array = new Uint8Array(buffer)
      // Create Blob
      const blob = new Blob([uint8Array], { type: 'application/gzip' })
      // Create object URL
      const url = URL.createObjectURL(blob)
      console.log('[PRELOAD] Created blob URL:', url)
      return url
    } catch (e) {
      console.error('[PRELOAD] Error getting model path:', e.message)
      throw e
    }
  },

  // Simple health‑check (useful for debugging)
  ping: () => ipcRenderer.invoke('ping'),

  getRuntimeInfo: () => ipcRenderer.invoke('get-runtime-info'),

  // Mic Stream
  getMicStream: async () => {
    try {
      console.log('[PRELOAD] Requesting microphone stream...')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      console.log('[PRELOAD] Microphone stream obtained')
      return stream
    } catch (e) {
      console.error('[PRELOAD] getMicStream error:', e.name, e.message)
      throw e
    }
  },

  // Desktop (system/speaker) Stream
  getDesktopAudioStream: async () => {
    try {
      console.log('[PRELOAD] Requesting desktop audio stream...')
      // The user sees a native dialog where they pick the whole screen
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true
      })
      console.log('[PRELOAD] Desktop audio stream obtained')
      return stream
    } catch (e) {
      console.error('[PRELOAD] getDesktopAudioStream error:', e.name, e.message)
      throw e
    }
  },

  // Helper to show a warning dialog (main process)
  showWarning: (msg) => ipcRenderer.invoke('show-warning', msg)
})

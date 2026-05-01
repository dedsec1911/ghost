// src/main.js
const { app, BrowserWindow, dialog, ipcMain, systemPreferences } = require('electron')
const path = require('path')
require('@electron/remote/main').initialize()

// ---- Utility: show an error dialog and exit -------------------------------------------------
function fatalError(msg) {
  console.error('[FATAL]', msg)
  dialog.showErrorBox('Fatal error', msg)
  app.quit()
}

// ---- Permission handling for macOS ---------------------------------------------------------
async function requestMacPermissions() {
  console.log('[PERMISSIONS] Requesting macOS permissions...')
  try {
    const micStatus = await systemPreferences.getMediaAccessStatus('microphone')
    console.log('[PERMISSIONS] Microphone status:', micStatus)
    if (micStatus !== 'granted') {
      console.log('[PERMISSIONS] Requesting microphone access...')
      const granted = await systemPreferences.askForMediaAccess('microphone')
      console.log('[PERMISSIONS] Microphone granted:', granted)
    } else {
      console.log('[PERMISSIONS] Microphone already granted')
    }

    // Screen access is optional - don't fail if it's not available
    try {
      const screenStatus = await systemPreferences.getMediaAccessStatus('screen')
      console.log('[PERMISSIONS] Screen status:', screenStatus)
      if (screenStatus !== 'granted') {
        console.log('[PERMISSIONS] Requesting screen access...')
        const granted = await systemPreferences.askForMediaAccess('screen')
        console.log('[PERMISSIONS] Screen granted:', granted)
      } else {
        console.log('[PERMISSIONS] Screen already granted')
      }
    } catch (screenError) {
      console.warn('[PERMISSIONS] Screen access not available (optional):', screenError.message)
    }
  } catch (e) {
    console.error('[PERMISSIONS] Error:', e.message)
  }
}

// ---- Create the browser window -------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      sandbox: false // required for getDisplayMedia on Windows/macOS
    }
  })

  win.webContents.on('console-message', (_, level, message, line, sourceId) => {
    console.log(`[RENDERER:${level}] ${message} (${sourceId}:${line})`)
  })

  win.webContents.on('render-process-gone', (_, details) => {
    console.error('[RENDERER] render-process-gone:', details)
  })

  win.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
    console.error('[RENDERER] did-fail-load:', errorCode, errorDescription, validatedURL)
  })

  win.on('unresponsive', () => {
    console.error('[RENDERER] window became unresponsive')
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  
  // Open developer tools in dev mode for debugging
  if (!app.isPackaged) {
    win.webContents.openDevTools()
    // Don't enable electron-reload - it can interfere with Vosk loading
    // require('electron-reload')(__dirname)
  }
}

// ---- App lifecycle ------------------------------------------------------------------------
app.whenReady()
  .then(async () => {
    console.log('[APP] Starting on', process.platform)
    if (process.platform === 'darwin') await requestMacPermissions()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch(e => fatalError(e.message))

app.on('window-all-closed', () => {
  // On macOS we keep the app alive until Cmd+Q
  if (process.platform !== 'darwin') app.quit()
})

// ---- IPC – simple health‑check -------------------------------------------------------------
ipcMain.handle('ping', () => 'pong')

ipcMain.handle('get-runtime-info', () => ({
  platform: process.platform,
  isPackaged: app.isPackaged
}))

ipcMain.handle('read-model-file', async () => {
  const { fs } = require('fs/promises')
  const modelName = 'vosk-model-small-en-us-0.15.tar.gz'
  try {
    let filePath
    if (!app.isPackaged) {
      filePath = path.join(app.getAppPath(), 'assets', 'model', modelName)
    } else {
      filePath = path.join(app.getAppPath(), '..', 'model', modelName)
    }
    console.log('[IPC] Reading model file:', filePath)
    const buffer = await require('fs').promises.readFile(filePath)
    // Return as array for safe IPC transfer
    return Array.from(buffer)
  } catch (e) {
    console.error('[IPC] Error reading model file:', e.message)
    throw e
  }
})

ipcMain.handle('show-warning', async (_, msg) => {
  await dialog.showMessageBox({
    type: 'warning',
    title: 'Potential Mis‑behaviour',
    message: msg,
    buttons: ['OK']
  })
})

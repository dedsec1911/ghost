# Project Context: Interview Helper

## Overview
**Interview Helper** is a cross-platform Electron app that provides real-time AI-powered answers during interviews. The app runs **invisibly during screen sharing** and captures audio to feed questions to the NVIDIA NIM API.

## Key Features
- 🔒 **Invisible to screen share** — Uses `setContentProtection(true)` to hide from Zoom, Meet, Teams, OBS, and screenshots
- 🎤 **Dual audio source** — Toggle Mic and/or Speaker capture separately
- 🗣 **Speech-to-Text** — Web Speech API (built into Electron/Chrome)
- 🤖 **NVIDIA NIM AI** — Sends questions to `openai/gpt-oss-120b` or any NVIDIA NIM model
- 📄 **Context/Resume** — Upload `.txt`, `.pdf`, or `.docx` files for personalized AI answers
- 📜 **Scrollable answer panel** — Auto-scrolls, markdown-formatted, copyable
- ⌨️ **Manual input** — Type questions directly
- 🖱 **Freely movable & resizable** — Drag and adjust window size
- ⌨️ **Hotkeys** — `Ctrl+Shift+H` (toggle), `Ctrl+Shift+X` (quit)

## Project Structure
```
package.json          # Electron app configuration, dependencies
README.md             # Full documentation and quickstart
src/
  main.js             # Main Electron process
  preload.js          # Preload script for IPC
  renderer/
    app.js            # Renderer process logic
    index.html        # UI markup
    style.css         # Styling
assets/               # Static resources
scripts/              # Build/utility scripts
```

## Tech Stack
- **Framework:** Electron 28.0.0
- **Build Tool:** electron-builder 24.0.0
- **AI API:** NVIDIA NIM (requires API key from https://build.nvidia.com)
- **File Parsing:** pdf-parse, mammoth (for PDF/DOCX resume parsing)
- **Networking:** node-fetch

## Key Dependencies
- `node-fetch`: HTTP requests to NVIDIA NIM API
- `pdf-parse`: Parse PDF resume files
- `mammoth`: Parse DOCX resume files

## Configuration
Users need:
1. NVIDIA API key (from https://build.nvidia.com)
2. Context/Resume upload (optional but improves AI answers)
3. Audio source selection (Mic, Speaker, or both)

## Build & Distribution
- **macOS DMG:** `npm run build:mac`
- **Windows NSIS:** `npm run build:win`
- **Both:** `npm run build:all`
- Output: `dist/` folder

## Important Notes
- **Screen Share Safety:** Core feature uses macOS `NSWindowSharingNone` for invisibility
- **Cross-platform:** macOS Intel and Windows 10/11 x64 support
- **Inspired by:** cheating-daddy project (GitHub reference)
- **STT Fixes Focus:** This fork (ghost-stt-fixes) likely addresses speech-to-text reliability issues

## Common Development Tasks
- Modify audio capture logic: [src/main.js](src/main.js)
- Update UI/UX: [src/renderer/](src/renderer/)
- Add new AI features: Integrate with NVIDIA NIM API calls
- Package for distribution: Use `npm run build:*` commands

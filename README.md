# Ghost — Stealth AI Interview Assistant

A cross-platform Electron app that sits **invisibly on your screen during screen sharing**, listens to your interview, and feeds questions to the NVIDIA NIM API for real-time AI answers.

---

## ✨ Features

| Feature | Detail |
|---|---|
| 🔒 **Invisible to screen share** | Uses `setContentProtection(true)` — completely hidden from Zoom, Meet, Teams, OBS, and screenshots |
| 🎤 **Dual audio source** | Toggle Mic and/or Speaker capture separately |
| 🗣 **Speech-to-text** | Web Speech API (built into Electron/Chrome) — no extra service needed |
| 🤖 **NVIDIA NIM AI** | Sends questions to `openai/gpt-oss-120b` (or any NVIDIA NIM model) |
| 📄 **Context / Resume** | Upload `.txt`, `.pdf`, or `.docx` resume — AI personalizes answers to your role & experience |
| 📜 **Scrollable answer panel** | Auto-scrolls on new answers, markdown-formatted, copyable |
| ⌨️ **Manual input** | Type questions yourself (Enter to submit) |
| 🖱 **Freely movable** | Drag from titlebar anywhere on screen |
| 🔧 **Resizable** | Drag bottom-right corner or set exact pixel size in Settings |
| ⌨️ **Hotkeys** | `Ctrl+Shift+H` toggle show/hide, `Ctrl+Shift+X` quit |

---

## � Screenshots

### Main Interface — Assistant Tab
<img width="421" height="640" alt="Screenshot 2026-05-01 at 15 32 48" src="https://github.com/user-attachments/assets/f18a0594-a37b-4eab-a56c-6acfbae14cc8" />

*The Assistant tab with audio controls, heard transcript, manual question input, and AI response display.*

### Settings Tab
<img width="420" height="643" alt="Screenshot 2026-05-01 at 15 31 44" src="https://github.com/user-attachments/assets/291fccf5-0fc0-4ad4-aac5-dee2fac41bdf" />

*Configure NVIDIA API key, select AI model, adjust opacity, and toggle stealth mode.*

### Context/Resume Tab
<img width="419" height="637" alt="Screenshot 2026-05-01 at 15 33 08" src="https://github.com/user-attachments/assets/a0f5867e-24ba-4a81-af48-0812e968a3f0" />

*Upload your resume and add interview context so AI personalizes answers to your role and experience.*
---

## �🚀 Quick Start

### Prerequisites

- **Node.js 18+** — https://nodejs.org
- **npm 9+**
- macOS Intel OR Windows 10/11 x64

### Install & Run (dev)

```bash
# 1. Clone / download the project
cd interview-helper

# 2. Install dependencies
npm install

# 3. Run in development mode
npm start
```

### Build distributables

```bash
# macOS Intel DMG
npm run build:mac

# Windows NSIS installer
npm run build:win

# Both at once
npm run build:all
```

Output files land in the `dist/` folder.

---

## ⚙️ Configuration

### 1. Get an NVIDIA API Key

1. Go to https://build.nvidia.com
2. Sign up / log in
3. Go to **API Keys** → **Generate Personal Key**
4. Copy the key (starts with `nvapi-…`)

### 2. Enter key in the app

Open the app → **Settings tab** → paste key → **Save Settings**

### 3. Add your context (important for good answers!)

**Context tab** → fill in:
- **Role** — e.g. `Senior Backend Engineer`
- **Years of experience** — e.g. `4`
- **Resume** — paste or upload your resume file
- **Notes** — company name, tech stack, interview focus

Click **Save Context**.

---

## 🔕 Screen Share Invisibility — How It Works

### macOS
`mainWindow.setContentProtection(true)` calls macOS's native `[NSWindow setSharingType: NSWindowSharingNone]`.  
This makes the window **completely invisible** in:
- Zoom screen share
- Google Meet screen share
- Microsoft Teams
- QuickTime screen recording
- macOS screenshots (Cmd+Shift+3/4)
- OBS capture

You will still see it on your own monitor.

### Windows (10 version 2004 and newer)
The same Electron API maps to `SetWindowDisplayAffinity(hWnd, WDA_EXCLUDEFROMCAPTURE)`.  
Result: window appears **black/blank** to screen capture tools, invisible to you.

> ⚠️ Windows requires build 19041+ (May 2020 Update). Older Windows will show the window normally.

---

## 🎤 Audio Sources

The Web Speech API inside Electron captures the **default system microphone**.

| Toggle | What it captures |
|---|---|
| **Mic ON** | Your microphone (you speaking) |
| **Speaker ON** | System audio via loopback* |
| **Both ON** | Both simultaneously |

> *Speaker capture requires a **virtual audio loopback** device:
> - **macOS**: Install [BlackHole](https://existential.audio/blackhole/) or [Loopback](https://rogueamoeba.com/loopback/)
> - **Windows**: Install [VB-Audio Virtual Cable](https://vb-audio.com/Cable/)
> 
> Set the virtual device as your default mic in System Preferences / Sound Settings. The app will then capture both mic and speaker audio together.

---

## 🤖 AI Models Available

| Model | Speed | Quality | Best for |
|---|---|---|---|
| `openai/gpt-oss-120b` | Fast | ⭐⭐⭐⭐⭐ | General interviews |
| `openai/gpt-oss-20b` | Very fast | ⭐⭐⭐⭐ | Quick answers |
| `meta/llama-3.3-70b-instruct` | Fast | ⭐⭐⭐⭐ | Technical depth |
| `meta/llama-3.1-405b-instruct` | Slower | ⭐⭐⭐⭐⭐ | Complex reasoning |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1` | Moderate | ⭐⭐⭐⭐⭐ | Best reasoning |
| `deepseek-ai/deepseek-r1-distill-qwen-32b` | Fast | ⭐⭐⭐⭐ | Coding questions |

---

## 🗂 Project Structure

```
interview-helper/
├── src/
│   ├── main.js          # Electron main process — window creation, stealth, IPC
│   ├── preload.js       # Context bridge — safe API for renderer
│   └── renderer/
│       ├── index.html   # UI shell
│       ├── style.css    # Dark overlay styles
│       └── app.js       # All UI logic, STT, AI calls
├── assets/
│   ├── icon.icns        # macOS icon (you provide)
│   └── icon.ico         # Windows icon (you provide)
├── package.json
└── README.md
```

---

## 🔧 Troubleshooting

**"Speech recognition not supported"**  
Electron's renderer uses Chromium. Web Speech API works but may need microphone permission. On macOS: System Preferences → Security & Privacy → Microphone → allow the app.

**App visible during screen share on Windows**  
Windows 10 before version 2004 doesn't support `WDA_EXCLUDEFROMCAPTURE`. Update Windows or use an older build of Electron (v12–v15) which had different behavior.

**No AI response**  
Check your API key in Settings. Make sure it starts with `nvapi-`. Try a different model if one is slow.

**Window too small after minimize**  
Set exact dimensions in Settings → Width/Height → Apply.

---

## 📝 License

MIT — use freely, build responsibly.

# TUBS BOT

Animated chatbot face with voice interaction, camera-based face detection/recognition, and presence-aware sleep/wake behavior. Runs entirely in the browser with a Node.js bridge server and Python STT/TTS backend.

## Quick Start

```bash
npm install
npm start          # Starts bridge server (port 3000) + Python STT/TTS (port 3001)
```

Open `http://localhost:3000` in your browser.

## Default Behavior

The bot starts **asleep** and the camera auto-enables. When a face is detected, the bot wakes up, greets you with TTS, and its eyes begin tracking your face. If no one is visible for a while, it goes back to sleep.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` (hold) | Push-to-talk — hold to record, release to send |
| `Space` (tap, while sleeping) | Wake up |
| `Escape` | Toggle sleep/wake |
| `S` | Toggle sleep/wake |
| `Z` | Zen mode — hide all panels |
| `C` | Toggle camera on/off |
| `D` | Toggle face detection debug panel |
| `F` | Enroll face — captures 5 samples and saves to library |
| `Enter` | Send typed text (type any characters, then Enter) |

## UI Panels

All four corner panels are **collapsible** — click the panel header to toggle.

- **System Vitals** (top-left) — Connection status, uptime, awake time, model
- **Input Status** (top-right) — Mic, volume, STT confidence, always-on VAD toggle, camera toggle, detection delay slider
- **Chat Log** (bottom-left) — All messages. Width is **resizable** by dragging the right edge.
- **Bot Stats** (bottom-right) — Response time, token counts, expression, session cost

## Camera & Face Detection

The camera PIP appears next to the Bot Stats panel when enabled. Face detection runs client-side via ONNX Runtime Web (SCRFD model for detection, ArcFace for recognition).

- **Detection delay slider** — Visible in Input Status when camera is on. Set to `auto` for adaptive throttling or drag to set a fixed interval (0.1s–5s).
- **Bounding boxes** — Green = recognized, orange = unknown. Corner accents and glow for visibility.
- **Presence badge** — Shows recognized names (or "N unknown") on the camera PIP.

### Face Enrollment

1. Press `F` (camera must be active)
2. Enter a name when prompted
3. Stay still — 5 samples are captured over ~4 seconds
4. Distinct embeddings are saved to the server

Enrolled faces are stored in `data/face-library.json` and loaded on camera start.

### Debug Panel

Press `D` to open the face debug overlay. Shows:
- The captured frame with bounding boxes drawn on it
- Inference time and capture interval
- Per-face detection confidence and match candidates with similarity scores

## Eye Tracking

When a face is detected, the bot's pupils follow the primary face position in the camera frame. This creates the effect of the bot "looking at" whoever is in front of the camera.

## Sleep / Wake

- **Auto-sleep** after configurable idle timeout (default 5 min). Adjust with the **Sleep** slider in the Input Status panel (10s–10m).
- **Auto-wake** when the camera detects a face
- **Wake triggers**: face detection, spacebar, click, Escape, typing
- **Greeting**: on face-triggered wake, the bot greets by name if enrolled ("Hey Flo!") or generically ("Hey there!") via TTS
- **Sleepy eyes**: eyelids half-close when sleeping, open on wake

## Architecture

```
Browser (vanilla JS)
  ├── main.js          — UI controller, expressions, TTS, keyboard, sleep/wake
  ├── face-manager.js  — Camera, worker orchestration, face matching, eye tracking
  └── face-worker.js   — Web Worker: SCRFD detection + ArcFace recognition (ONNX)

Node.js Bridge Server (src/bridge-server.js)
  ├── Static file server (public/)
  ├── WebSocket relay
  ├── Face library CRUD API (/faces)
  └── Proxies to Python STT/TTS

Python Service (src/transcription-service.py)
  ├── STT via faster-whisper
  └── TTS via macOS `say` command
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server health check |
| `/stats` | GET | Server statistics |
| `/voice` | POST | Send audio for transcription + response |
| `/tts` | POST | Text-to-speech (returns WAV) |
| `/faces` | GET | List all enrolled faces |
| `/faces` | POST | Add face `{ name, embedding }` |
| `/faces?id=xxx` | DELETE | Remove a face by ID |
| `/sleep` | POST | Put bot to sleep |
| `/wake` | POST | Wake bot up |
| `/config` | GET | Get current config |
| `/config` | POST | Update runtime config (supports `sttModel`, restarts STT service if changed) |

### Whisper Model Selection

You can switch the transcription model at runtime:

```bash
curl -X POST http://localhost:3000/config \
  -H "Content-Type: application/json" \
  -d '{"sttModel":"tiny"}'
```

The bridge will restart the Python transcription service with `WHISPER_MODEL=tiny`.

## Models

Downloaded automatically on first camera use and cached in browser IndexedDB:

- **SCRFD det_10g** (~17MB) — Face detection
- **ArcFace w600k_r50** (~174MB) — Face recognition embeddings

First load takes ~30s depending on connection. Subsequent loads are instant from cache.

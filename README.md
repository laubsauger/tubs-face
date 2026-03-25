# TUBS BOT

Animated chatbot face with voice interaction, streaming TTS, camera-based face detection/recognition, presence-aware sleep/wake behavior, and multi-device spectator mode. TypeScript monorepo with React frontend, Node.js server, and Python STT/TTS backend.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev        # Dev: tsx watch server + vite client (port 5173)
npm start          # Production: compiled server (port 3000)
```

Open `http://localhost:5173` (dev) or `http://localhost:3000` (production).

### macOS Python Setup

`npm install` now uses `requirements-macos.txt` plus a separate `mlx-audio` install step on macOS. That avoids a broken resolver path in `mlx-audio==0.2.10`'s published dependency metadata.

If you need to bootstrap the Python side manually on macOS, run:

```bash
python3.11 -m venv venv
./venv/bin/pip install -r requirements-macos.txt
./venv/bin/pip install --no-deps mlx-audio==0.2.10
```

### Windows Support

On Windows, `npm install` gracefully defers to `scripts/setup-python.ps1` to establish the `.venv` and install backend packages. 
- You still need **Python 3.10+** (add to PATH).
- You still need **C++ Build Tools** installed if you haven't (for some ML dependencies to compile).
- If you face execution policy errors running the `.ps1` auto-setup script, you can run `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` in an admin PowerShell, or manually create the venv: `python -m venv venv` and `.\venv\Scripts\Activate.ps1`, then `pip install -r requirements.txt`.

### Processing Modes

- `PROCESSING_MODE` is selected at server startup and exposed by `/health` + `/config`.
- **Legacy**: default production stack (Whisper STT + Gemini LLM + streaming TTS).
- **Realtime**: dedicated realtime stack via `src/realtime-processing-service.py`.
  - STT: `lightning-whisper-mlx` (`REALTIME_STT_BACKEND=mlx`)
  - TTS: Kokoro (`REALTIME_TTS_BACKEND=kokoro`, voice from `KOKORO_VOICE` / `REALTIME_KOKORO_VOICE`)
  - LLM: Ollama-compatible chat API (`REALTIME_LLM_PROVIDER=ollama`, `OLLAMA_HOST` or `REALTIME_LLM_BASE_URL`)
  - Required: `REALTIME_LLM_MODEL` must be set to an installed model from `ollama list`
  - Optional: `DUAL_HEAD_LLM_MODEL` for dedicated dual-head script generation

### LLM Benchmarking

Use the benchmark harness to compare latency by input length and stack path:

```bash
npm run bench:llm -- \
  --target ollama,realtime,assistant \
  --models "hf.co/NexaAI/Qwen2-Audio-7B-GGUF:Q4_K_M,omniaudio-local:q4km" \
  --runs 3 \
  --warmup 1 \
  --timeout_ms 90000 \
  --out_json /tmp/llm-bench.json
```

Targets:
- `ollama`: direct `POST /api/chat`
- `realtime`: `POST /llm/generate` on realtime Python service
- `assistant`: full assistant pipeline (`src/server/assistant/`) using configured provider

## Default Behavior

The bot starts **asleep** and the camera auto-enables. When a face is detected, the bot wakes up, greets you with TTS, and its eyes begin tracking your face. If no one is visible for a while, it goes back to sleep.

When Tubs asks for donations, a Venmo QR card appears in the UI.
When donation intent is detected from user speech/text, Tubs briefly switches to a heart-eyes `love` expression.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` (hold) | Push-to-talk — hold to record, release to send |
| `Space` (tap, while sleeping) | Wake up |
| `Escape` | Toggle sleep/wake |
| `S` | Toggle sleep/wake |
| `Z` | Zen mode — hide all panels |
| `C` | Toggle camera on/off |
| `X` | Toggle fullscreen |
| `D` | Toggle face detection debug panel |
| `F` | Enroll face — captures 5 samples and saves to library |
| `Enter` | Send typed text (type any characters, then Enter) |

## UI Panels

All four corner panels are **collapsible** — click the panel header to toggle.

- **System Vitals** (top-left) — Connection status, uptime, awake time, model
- **Input Status** (top-left stack) — Mic, volume, STT confidence, always-on VAD toggle, camera toggle, fullscreen toggle, detection delay slider
- **Chat Log** (bottom-left) — All messages. Width is **resizable** by dragging the right edge.
- **Bot Stats** (bottom-right) — Response time, token counts, expression, session cost

Session cost is estimated from token counts using optional `.env` pricing values (`GEMINI_INPUT_COST_PER_MTOKENS`, `GEMINI_OUTPUT_COST_PER_MTOKENS`).

## Expression Reactions

- `love` may trigger when users indicate they donated or will donate.
- `crying` may trigger occasionally when a recognized person leaves without a donation signal.
- Subtle animated scanlines run across face features so the face keeps visual motion even when idle.

Donation-triggered `love` supports two signal strengths:
- **Implied**: user says they donated / will donate.
- **Confident**: server-side confirmation (manual endpoint or webhook ingestion).

You can choose mode in config: `both`, `implied`, `confident`, or `off`.

LLM replies can optionally include one trailing supported emoji token (as the last character) to drive face mood/expression cues without runtime sentiment analysis.
Supported trailing emoji mappings:
- `🙂` warm/friendly
- `😄` excited joy
- `😏` sassy/playful
- `🥺` pleading/soft
- `😢` sad/hurt
- `😤` fired up/intense
- `🤖` deadpan robot
- `🫶` grateful/love

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

When a face is detected, the bot adjusts eye position toward the average detected face position in the camera frame. This creates the effect of the bot "looking at" people in front of it.

## Sleep / Wake

- **Auto-sleep** after configurable idle timeout (default 10s). Adjust with the **Sleep** slider in the Input Status panel (5s–10m).
- **Auto-wake** when the camera detects a face
- **Wake triggers**: face detection, spacebar, click, Escape, typing
- **Greeting**: on face-triggered wake, the bot greets by name if enrolled ("Hey Flo!") or generically ("Hey there!") via TTS
- **Sleepy face**: eyes narrow and UI dims while sleeping

## Architecture

```
React Frontend (TypeScript + Vite + Zustand)
  ├── src/client/main.ts            — main client bootstrap
  ├── src/client/mini-main.ts       — mini display bootstrap
  ├── src/client/spectator-main.ts  — spectator (read-only) bootstrap
  ├── src/client/audio/*            — speech playback, voice input, ambient
  ├── src/client/face/*             — face rendering, behavior, detection
  ├── src/client/glitch/*           — glitch FX (canvas/WebGPU)
  ├── src/client/transport/*        — WebSocket + HTTP clients
  ├── src/client/state/*            — Zustand store
  └── src/workers/face-worker.ts    — SCRFD + ArcFace (ONNX Runtime Web)

Node.js Server (TypeScript, port 3000)
  ├── src/server/index.ts           — HTTP + WebSocket server
  ├── src/server/ws/server.ts       — WebSocket relay, broadcast, spectator tracking
  ├── src/server/routes/api.ts      — REST API surface
  ├── src/server/assistant/*        — LLM orchestration, dual-head, emotion, context
  ├── src/server/llm/*              — Gemini streaming, provider abstraction
  ├── src/server/tts/stream.ts      — Streaming audio chunks over WebSocket
  └── src/server/config/runtime.ts  — mutable runtime config

Shared Contracts (src/shared/contracts/)
  └── Type-safe WebSocket, HTTP, config, turn-script interfaces

Python Service (src/transcription-service.py, port 3001)
  ├── STT via faster-whisper / MLX
  └── TTS proxy (Kokoro / macOS say)

Persona (src/persona/)
  ├── system-prompt.txt             — personality/soul
  └── greetings.json                — fast greeting presets
```

### Client Modes

| Mode | Entry | URL | Description |
|------|-------|-----|-------------|
| **Main** | `index.html` | `/` | Full client — voice, camera, debug panels, all controls |
| **Mini** | `app-mini.html` | `/app-mini.html` | Display-only secondary window — face + subtitles |
| **Spectator** | `spectator.html` | `/spectator.html` | Read-only mobile client for crowd engagement |

## Spectator Mode

Lightweight read-only client for audience engagement at live events. Spectators see the same face, expressions, subtitles, and hear the same audio as the main client — perfectly synced across dozens of devices.

### How It Works

1. Audience scans a QR code or opens a URL on their phone
2. `/spectator.html` loads a minimal client (face + subtitles, no input UI)
3. WebSocket connects with `?role=spectator` — server ignores all input except pings
4. Server broadcasts all output to every client, so spectators receive everything for free

### Setup (Same WiFi)

```bash
npm run dev
# Get the spectator URL with auto-detected local IP:
curl http://localhost:3000/api/spectator-url
# → {"url":"http://192.168.1.42:3000/spectator.html","ip":"192.168.1.42","port":3000,"spectators":0}
```

Share the URL or generate a QR code from it. Everyone on the same network connects instantly.

### Setup (Remote)

```bash
ngrok http 5173   # dev
ngrok http 3000   # production
```

Share `https://<ngrok-id>.ngrok.io/spectator.html`.

### Actor Filter (Dual-Head)

In dual-head mode (two characters), spectators can focus on one:

```
/spectator.html?actor=main    # primary character only
/spectator.html?actor=small   # secondary character only
```

The `/api/spectator-url?actor=main` endpoint includes the actor param in the returned URL.

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
| `/config` | POST | Update runtime config (supports `sttModel`, `llmModel`, `llmMaxOutputTokens`, `donationSignalMode`, `minFaceBoxAreaRatio`; `processingMode` is startup-only) |
| `/checkout/paypal/order` | POST | Create PayPal order (optional checkout flow) |
| `/checkout/paypal/capture` | POST | Capture PayPal order; emits confident donation signal on completion |
| `/donations/confirm` | POST | Manual donation signal injection (`implied`/`confident`) |
| `/webhooks/paypal` | POST | PayPal webhook ingestion (maps supported event types to donation signals) |
| `/api/spectator-url` | GET | Spectator URL with auto-detected LAN IP + spectator count |

### Whisper Model Selection

You can switch the transcription model at runtime:

```bash
curl -X POST http://localhost:3000/config \
  -H "Content-Type: application/json" \
  -d '{"sttModel":"tiny"}'
```

The bridge will restart the Python transcription service with `WHISPER_MODEL=tiny`.

### LLM Model Selection

Configure Gemini in `.env`:

```bash
GEMINI_API_KEY=your_key
GEMINI_MODEL=gemini-2.5-flash
GEMINI_MAX_OUTPUT_TOKENS=120
ASSISTANT_HISTORY_TTL_MS=240000
ASSISTANT_MEMORY_TTL_MS=360000
PRESENCE_CONTEXT_CLEAR_DELAY_MS=60000
PRESENCE_CONTEXT_CLEAR_COOLDOWN_MS=15000
MIN_FACE_BOX_AREA_RATIO=0.02
```

You can also change model/token cap at runtime:

```bash
curl -X POST http://localhost:3000/config \
  -H "Content-Type: application/json" \
  -d '{"llmModel":"gemini-2.5-flash-lite","llmMaxOutputTokens":96}'
```

### Face Distance Filter

Ignore tiny/far faces by bounding-box area ratio (fraction of full camera frame):

```bash
curl -X POST http://localhost:3000/config \
  -H "Content-Type: application/json" \
  -d '{"minFaceBoxAreaRatio":0.02}'
```

Increase this value to focus on closer people. Set `0` to disable filtering.
At `0.02`, a square face box must be roughly `109x109` px on a `1024x576` frame.

### Persona Editing

- `src/persona/system-prompt.txt` — assistant soul/personality.
- `src/persona/greetings.json` — hardcoded fast greetings and trigger words.
- `.env` donation settings:
  - `DONATION_VENMO`
  - `DONATION_QR_DATA`
  - `DONATION_SIGNAL_MODE` (`both`/`implied`/`confident`/`off`)
  - `DONATION_WEBHOOK_TOKEN` (optional shared token for donation/webhook endpoints)

### Donation Signals

Manual confident/implied signal:

```bash
curl -X POST http://localhost:3000/donations/confirm \
  -H "Content-Type: application/json" \
  -H "X-Donation-Token: $DONATION_WEBHOOK_TOKEN" \
  -d '{"certainty":"confident","source":"manual","amount":5.00,"currency":"USD","note":"test ping"}'
```

Runtime mode switching:

```bash
curl -X POST http://localhost:3000/config \
  -H "Content-Type: application/json" \
  -d '{"donationSignalMode":"both"}'
```

PayPal webhook mapping currently handled:
- `PAYMENT.CAPTURE.COMPLETED` -> `confident`
- `CHECKOUT.ORDER.APPROVED` -> `implied`

Optional PayPal checkout flow (server-side order + capture):

```bash
curl -X POST http://localhost:3000/checkout/paypal/order \
  -H "Content-Type: application/json" \
  -d '{"amount":"5.00","currency":"USD","description":"Wheels for Tubs"}'
```

```bash
curl -X POST http://localhost:3000/checkout/paypal/capture \
  -H "Content-Type: application/json" \
  -d '{"orderId":"REPLACE_WITH_ORDER_ID"}'
```

`.env` for checkout:
- `PAYPAL_ENV` (`sandbox` or `live`)
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_DEFAULT_DONATION_AMOUNT` (fallback when amount not provided)

## Models

Downloaded automatically on first camera use and cached in browser IndexedDB:

- **SCRFD det_10g** (~17MB) — Face detection
- **ArcFace w600k_r50** (~174MB) — Face recognition embeddings

First load takes ~30s depending on connection. Subsequent loads are instant from cache.

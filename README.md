# TUBS BOT

Animated chatbot face with voice interaction, camera-based face detection/recognition, and presence-aware sleep/wake behavior. Runs entirely in the browser with a Node.js bridge server and Python STT/TTS backend.

## Quick Start

```bash
npm install
cp .env.example .env
npm start          # Starts bridge server (port 3000) + Python STT/TTS (port 3001)
```

Open `http://localhost:3000` in your browser.

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
Browser (vanilla JS)
  ├── public/js/main.js         — app bootstrap + startup wiring
  ├── public/js/message-handler.js
  ├── public/js/audio-input.js
  ├── public/js/face/*          — camera, worker orchestration, matching, debug
  └── public/js/face-worker.js  — Web Worker: SCRFD detection + ArcFace recognition (ONNX)

Node.js Bridge Server (src/bridge-server.js)
  ├── Static file server (public/)
  ├── WebSocket relay
  ├── Face library CRUD API (/faces)
  └── Proxies to Python STT/TTS

Python Service (src/transcription-service.py)
  ├── STT via faster-whisper
  └── TTS via macOS `say` command

LLM Assistant (Gemini API)
  ├── src/assistant-service.js — conversation flow + short context memory
  ├── src/gemini-client.js     — generateContent API call
  └── src/persona/*            — editable persona prompt + greeting presets
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
| `/config` | POST | Update runtime config (supports `sttModel`, `llmModel`, `llmMaxOutputTokens`, `donationSignalMode`, `minFaceBoxAreaRatio`) |
| `/checkout/paypal/order` | POST | Create PayPal order (optional checkout flow) |
| `/checkout/paypal/capture` | POST | Capture PayPal order; emits confident donation signal on completion |
| `/donations/confirm` | POST | Manual donation signal injection (`implied`/`confident`) |
| `/webhooks/paypal` | POST | PayPal webhook ingestion (maps supported event types to donation signals) |

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
MIN_FACE_BOX_AREA_RATIO=0.03
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
  -d '{"minFaceBoxAreaRatio":0.03}'
```

Increase this value to focus on closer people. Set `0` to disable filtering.
At `0.03`, a square face box must be roughly `130x130` px on a `1024x576` frame.

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

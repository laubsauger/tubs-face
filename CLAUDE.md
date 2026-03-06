# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start             # Start bridge server (port 3000) + Python transcription service (port 3001)
npm run dev           # Same as start
npm run kill          # Kill both Node and Python processes
npm run restart       # Kill + sleep 1s + start

# Python deps (if not using the committed venv/)
pip install -r requirements.txt
```

No test suite exists. No linter configured.

## Architecture

Three-layer system: **Browser frontend** → **Node.js bridge server** → **Python STT/TTS microservice**.

### Bridge Server (`src/bridge-server.js`)
- HTTP server + WebSocket relay on port 3000
- Serves static files from `public/`
- Spawns the Python transcription service as a child process
- Proxies `/tts` requests to Python on port 3001
- Implements wake-word detection for voice input (30+ fuzzy variants of "hey tubs")
- HTTP API: `/health`, `/stats`, `/speak`, `/voice`, `/tts`, `/sleep`, `/wake`, `/config`

### Python Service (`src/transcription-service.py`)
- Flask app on port 3001
- STT via `faster-whisper` (Whisper model, CPU, int8)
- TTS via macOS `say` command + `afconvert` to WAV (macOS-only)
- Endpoints: `/transcribe` (POST multipart audio), `/tts` (POST JSON), `/health`

### LLM Layer (`src/llm/`)
- `provider.js` — abstraction that resolves to Gemini or Realtime provider (via `LLM_PROVIDER` env var)
- `providers/gemini.js` — Gemini API via `src/gemini-client.js` (supports streaming)
- `providers/realtime.js` — Gemini Realtime/Live API
- Requires `GEMINI_API_KEY` env var

### Assistant Layer (`src/assistant/`)
- `generate.js` — main LLM response generation (single-head mode)
- `dual-head.js` — structured dual-head mode (scripted multi-beat responses with actor/action schema)
- `context.js` — conversation context/history management
- `emotion.js` — emotion extraction from LLM output
- `donation.js` — donation signal handling (Venmo/PayPal)
- `constants.js`, `text.js` — shared constants and text utilities

### Frontend (`public/`)
- Single-page vanilla JS app (`js/main.js`, `css/style.css`, `index.html`)
- Animated face with expressions: idle, listening, thinking, speaking, smile, happy
- WebSocket client for real-time communication with bridge
- Voice input: push-to-talk (spacebar) + always-on VAD (`@ricky0123/vad-web` from CDN)
- TTS playback with browser `SpeechSynthesis` fallback
- Sleep mode with auto-timeout (5 min default), wake via spacebar/click/voice
- Zen mode: press `Z` to hide all panels

## WebSocket Protocol

Messages are JSON with a `type` field. Key types:
- Server→Client: `speak`, `incoming`, `thinking`, `expression`, `system`, `error`, `sleep`, `wake`, `stats`, `config`
- Client→Server: `incoming` (user text)
- Bidirectional: `ping` (latency, every 5s)

### Other Server Modules
- `src/config.js` — runtime config
- `src/langfuse.js` — Langfuse observability integration
- `src/processing/` — processing mode management
- `src/persona/` + `src/persona.js` — persona/system prompt management
- `src/face-library.js` + `data/face-library.json` — face identity storage

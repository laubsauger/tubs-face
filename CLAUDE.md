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
- Contains `generateDemoResponse()` — placeholder for real LLM integration
- HTTP API: `/health`, `/stats`, `/speak`, `/voice`, `/tts`, `/sleep`, `/wake`, `/config`

### Python Service (`src/transcription-service.py`)
- Flask app on port 3001
- STT via `faster-whisper` (Whisper model, CPU, int8)
- TTS via macOS `say` command + `afconvert` to WAV (macOS-only)
- Endpoints: `/transcribe` (POST multipart audio), `/tts` (POST JSON), `/health`

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

## Key Integration Point

To connect a real LLM, replace `generateDemoResponse(input)` in `src/bridge-server.js` with an actual API call. The `/voice` endpoint currently: transcribes audio → calls this function → broadcasts the response as a `speak` message.

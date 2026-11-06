# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev           # Start dev: tsx watch server + vite client (concurrent)
npm start             # Start production server (compiled dist/)
npm run build         # Build client (vite) + server (tsc)
npm run typecheck     # Full TypeScript validation (both configs)
npm run test          # vitest run
npm run bench:llm     # Benchmark LLM performance

# Python deps (if not using the committed venv/)
pip install -r requirements.txt
npm run setup-ming    # venv-ming for the cloned voices (Apple Silicon); the server starts Ming once it exists
```

## Architecture

Three-layer TypeScript system: **React frontend** → **Node.js server** → **Python STT/TTS microservice**.

Monorepo with shared type-safe contracts. Build: Vite (client) + tsc (server). Dev uses `tsx watch` for server hot-reload.

### Server (`src/server/`) — TypeScript, port 3000

**Entry:** `index.ts` — HTTP server + WebSocket init

- `ws/server.ts` — WebSocket server, client tracking, message routing, broadcast
- `assistant/service.ts` — LLM orchestration, turn management
- `assistant/dual-head.ts` — Structured multi-beat responses (actor/action schema)
- `assistant/context.ts` — Conversation history
- `assistant/emotion.ts` — Emotion extraction
- `assistant/text.ts` — Output normalization, TTS sanitization
- `assistant/sentence-splitter.ts` — Break responses into utterances
- `assistant/prompt.ts` — System instruction builders
- `assistant/vision.ts` — Camera/image analysis
- `llm/provider.ts` — Router: Gemini, or Ollama/OpenAI via the Python service (`LLM_PROVIDER` env); both stream
- `llm/gemini-client.ts` — Gemini API streaming with SSE
- `llm/providers/gemini.ts` — Structured generation wrapper
- `llm/providers/realtime.ts` — Gemini Realtime/Live API
- `processing/speech-service.ts` — Starts and supervises the Python speech service and the Ming TTS service
- `tts/stream.ts` — Streaming audio chunks to WebSocket
- `config/runtime.ts` — Runtime configuration, session stats
- `routes/api.ts` — REST: `/health`, `/stats`, `/config`, `/speak`, `/faces`, `/api/*`
- `recordings.ts` — Face-window video recordings, appended piece by piece, remuxed to plain MP4 by ffmpeg when present; saved to `~/Movies/tubs-recordings` (`TUBS_RECORDINGS_DIR`)

### Python Service (`src/realtime-processing-service.py`)
- Flask app on port 3002, started and restarted by the server
- STT: `lightning-whisper-mlx` (Apple Silicon) or `faster-whisper` (CPU, int8). Clips in which Silero VAD (bundled with faster-whisper) finds under `REALTIME_VAD_MIN_SPEECH_MS` (250) of speech skip Whisper; transcripts Whisper scores as no speech are dropped too
- TTS: Kokoro (MLX on macOS, native elsewhere), streamed per sentence over `/tts/stream`; or system TTS (macOS `say`, pyttsx3 elsewhere)
- LLM proxy for Ollama / OpenAI-compatible models: `/llm/generate`, `/llm/stream`
- Endpoints: `/transcribe`, `/tts`, `/tts/stream`, `/llm/*`, `/health`
- Voices starting with `ming:` (`ming:friend` is main Tubs' cloned voice, `ming:friend-b` Mini's) are forwarded to a separate Ming TTS service at `MING_TTS_URL` (default `127.0.0.1:3003`), with the part after `ming:` as the voice name. When Ming is down, each falls back to its head's Kokoro voice. Start Tubs with `REALTIME_KOKORO_VOICE=ming:friend SECONDARY_VOICE=ming:friend-b DUAL_HEAD_ENABLED=true DUAL_HEAD_MODE=llm_directed`; runtime config does not survive a restart. Ming is `src/ming-tts-service.py`. It needs a newer mlx than STT, so it runs from its own venv, `venv-ming` (`npm run setup-ming`, pinned in `requirements-ming.txt`). The server starts and supervises it when that venv exists, unless something already listens on `MING_PORT` (3003). Its voice references are recordings of a real person and stay out of git, in `data/ming-voices/` (`MING_VOICE_DIR`); the listening tests behind its settings are in `~/Movies/tubs-voice-lab/`. Ming gets whole replies, not sentences, and streams each back in chunks from its `/tts/stream` as it renders (falls back to its `/tts` if that route is missing). The chunks of one reply carry the same text, all but the last flagged `more`; the client plays them back to back under one subtitle, in a 24 kHz AudioContext so the mid-word cuts join sample for sample.

### Client (`src/client/`) — React + TypeScript + Zustand

**Entry:** `main.ts` → `bootstrap-react.tsx` (initializes runtimes, React root)

Two build entries: `index.html` (main) and `app-mini.html` (mini display mode). `/?view=dashboard` is the operator HUD for a separate screen (no face, no audio, mic or camera); `app-mini.html?embed=1` is the mini tile inside the face window.

**Runtime-based architecture** — each subsystem is a standalone runtime with `init()`, `bind()`, `dispose()`:

- `audio/speech-runtime.ts` — Server audio playback (streaming queue), subtitle timing
- `audio/screen-recorder.ts` — Record button / R key: this tab's video and audio plus the mic, mixed, uploaded to the server each second
- `audio/voice-runtime.ts` — Mic input + VAD (push-to-talk + hands-free)
- `audio/ambient-runtime.ts` — Background sounds
- `face/runtime.ts` — Face shell, camera input, face detection
- `face/behavior-runtime.ts` — Expression & animation synced with speech
- `glitch/runtime.ts` — Pixel face with glitch effects (WebGPU only)
- `fx/runtime.ts` — Visual effects (filters, overlays)
- `behavior/emotion-runtime.ts` — Emotional state
- `behavior/proactive-runtime.ts` — Proactive/greeting responses
- `transport/ws-client.ts` — Managed WebSocket with reconnection
- `state/app-state.ts` — Zustand store with `subscribeWithSelector`
- `handlers/messages.ts` — Routes WS messages to state updates
- `ui/app-shell.tsx` — Shells (face, dashboard, mini, spectator) and the operator hotkey router
- `ui/hud/` — Operator HUD: status bar, tabbed dock, floating transcript, mini tile; pure rules in `dock-state.ts`, `hotkeys.ts`, `transcript.ts`
- `ui/window-link.ts` — BroadcastChannel between face, mini and dashboard windows (presence, device-state relay)

### Shared Contracts (`src/shared/contracts/`)

Type-safe communication layer:
- `ws.ts` — Full WebSocket protocol (all client & server message types)
- `turn-script.ts` — Turn structure: beats (actor + action), emotions
- `config.ts` — Runtime config shape, expression names
- `http.ts` — HTTP request/response types
- `faces.ts` — Face detection & storage contracts

## WebSocket Protocol

Messages are JSON with a `type` field. Full types in `src/shared/contracts/ws.ts`.

**Client → Server:** `ping`, `incoming`, `interrupt`, `face_motion`, `face_blink`, `head_speech_state`, `presence`, `camera_frame`, `appearance_frame`, `tts_request`

**Server → Client:** `ping`, `config`, `system`, `expression`, `thinking`, `speak`, `speak_chunk`, `speak_end`, `audio_chunk`, `turn_start`, `turn_script`, `turn_context`, `interrupt`, `backchannel`, `incoming`, `donation_signal`, `stats`, `stream_debug`, `conversation_mode`, `sleep`, `wake`, `error`, `face_motion`, `face_blink`, `head_speech_state`

## Key Patterns

- **Runtime composition** — features are standalone runtimes, not class hierarchies
- **Streaming-first** — audio chunks streamed incrementally (not full responses)
- **Dual-head** — structured multi-beat responses with different actors/actions
- **Broadcast model** — server broadcasts all messages to all connected WS clients
- Requires `GEMINI_API_KEY` env var

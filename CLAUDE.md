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
- `llm/provider.ts` — Router: Gemini or Realtime (via `LLM_PROVIDER` env)
- `llm/gemini-client.ts` — Gemini API streaming with SSE
- `llm/providers/gemini.ts` — Structured generation wrapper
- `llm/providers/realtime.ts` — Gemini Realtime/Live API
- `processing/mode-manager.ts` — Processing mode router (legacy/realtime)
- `tts/stream.ts` — Streaming audio chunks to WebSocket
- `config/runtime.ts` — Runtime configuration, session stats
- `routes/api.ts` — REST: `/health`, `/stats`, `/config`, `/speak`, `/faces`, `/api/*`

### Python Service (`src/transcription-service.py`)
- Flask app on port 3001
- STT via `faster-whisper` (Whisper model, CPU, int8)
- TTS via macOS `say` + `afconvert` (macOS-only)
- Endpoints: `/transcribe`, `/tts`, `/health`

### Client (`src/client/`) — React + TypeScript + Zustand

**Entry:** `main.ts` → `bootstrap-react.tsx` (initializes runtimes, React root)

Two build entries: `index.html` (main) and `app-mini.html` (mini display mode).

**Runtime-based architecture** — each subsystem is a standalone runtime with `init()`, `bind()`, `dispose()`:

- `audio/speech-runtime.ts` — Server audio playback (streaming queue), subtitle timing
- `audio/voice-runtime.ts` — Mic input + VAD (push-to-talk + hands-free)
- `audio/ambient-runtime.ts` — Background sounds
- `face/runtime.ts` — Face shell, camera input, face detection
- `face/behavior-runtime.ts` — Expression & animation synced with speech
- `glitch/runtime.ts` — Glitch effect rendering (canvas/WebGPU)
- `fx/runtime.ts` — Visual effects (filters, overlays)
- `behavior/emotion-runtime.ts` — Emotional state
- `behavior/proactive-runtime.ts` — Proactive/greeting responses
- `transport/ws-client.ts` — Managed WebSocket with reconnection
- `state/app-state.ts` — Zustand store with `subscribeWithSelector`
- `handlers/messages.ts` — Routes WS messages to state updates
- `ui/app-shell.tsx` — Main React shell with debug panels

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
- **Mode switching** — processing modes (legacy/realtime) swappable at runtime
- **Broadcast model** — server broadcasts all messages to all connected WS clients
- Requires `GEMINI_API_KEY` env var

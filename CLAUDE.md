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

## Run on a studio Mac (a studio-manager service)

Install once: Node 24, `npm ci`, the speech service's Python venv (`venv/`, `pip install -r requirements.txt`), `npm run setup-ming` (`venv-ming/`, Apple Silicon), Google Chrome (the face pages run in it). The site node (mediamtx) comes from studio-manager; its user `tubs` may only publish, on `~^tubs-`.

Copy the private files, never in git: `.env` (`GEMINI_API_KEY`, `LLM_PROVIDER`, …), `data/face-library.json` (the people Tubs recognises), `data/ming-voices/` (the cloned voices' references) and the site login, `data/site-login.json`: `{"user": "tubs", "pass": "…"}` (`chmod 600`; also `user:pass` or two lines). `data/tubs-state.json` is created on the machine.

```bash
PORT=3100 TUBS_STUDIO=1 TUBS_STUDIO_SITE=http://127.0.0.1:8889 \
TUBS_STUDIO_SITE_AUTH=data/site-login.json TUBS_STATE_FILE=data/tubs-state.json \
TUBS_MIC_SOURCE=off TUBS_VISION_SOURCE=off \
REALTIME_KOKORO_VOICE=ming:friend SECONDARY_VOICE=ming:friend-b DUAL_HEAD_ENABLED=true DUAL_HEAD_MODE=llm_directed \
npx tsx src/server/index.ts
```

- Health check: `GET /healthz` is 200 once the speech service, Ming (for `ming:` voices) and, in studio mode, both face pages are up, else 503; `GET /health` shows each part.
- The site login reaches only the face pages (an Authorization header for WHIP; `TUBS_STUDIO_SITE_READ_AUTH` for WHEP reads if the site needs one); never in env values, URLs, `GET /studio` or the log. A missing file or a refused login (401) shows as each head's error in `GET /studio`; a refused login is retried every 30 s.
- The Studio tab offers the mic and vision sources as pick lists (`GET /studio/sources`): this Mac's devices (from the listener page), the site node's live paths (its mediamtx API, `TUBS_STUDIO_SITE_API`, default the site host on :9997; login `TUBS_STUDIO_SITE_API_AUTH`, else the read login) and, with `FLEET_HUB` set, the floor plan's placed depth cameras as snapshots.
- `TUBS_STATE_FILE` keeps the operator's choices across restarts: the preset, the relationships toggle, the vision provider and model, the mic and vision sources (never a key).
- Stop with SIGTERM. The Python speech service, Ming and the face pages' Chrome run in their own process groups under a guard (`processing/owned-process.ts`), so even a SIGKILLed server leaves nothing behind.

## Architecture

Three-layer TypeScript system: **React frontend** → **Node.js server** → **Python STT/TTS microservice**.

Monorepo with shared type-safe contracts. Build: Vite (client) + tsc (server). Dev uses `tsx watch` for server hot-reload.

### Server (`src/server/`) — TypeScript, port 3000

**Entry:** `index.ts` — HTTP server + WebSocket init

- `ws/server.ts` — WebSocket server, client tracking, message routing, broadcast
- `assistant/service.ts` — LLM orchestration, turn management
- `assistant/dual-head.ts` — Structured multi-beat responses (actor/action schema)
- `assistant/context.ts` — Conversation history
- `assistant/fillers.ts` — A short pre-rendered sound ("Hmm.") at the start of some voice turns, in main's voice, while the reply is generated; rendered at startup once Ming is ready
- `assistant/emotion.ts` — Emotion extraction
- `assistant/text.ts` — Output normalization, TTS sanitization
- `assistant/sentence-splitter.ts` — Break responses into utterances
- `assistant/prompt.ts` — System instruction builders
- `assistant/vision.ts` — What Tubs sees: camera pictures described for the reply prompt (`docs/vision.md`). Provider `off` (no picture leaves the server), `gemini`, or `openai` (any OpenAI-compatible `/chat/completions`, or `fleet:vision`, a box picked by the studio-manager hub at `FLEET_HUB`), all live via `POST /config`; hourly cap, no refreshes while asleep, last description kept on failure; counts in `/stats` `vision`. Parts in `vision/` (`budget.ts`, `fleet.ts`, `providers.ts`, `stats.ts`). Env: `VISION_PROVIDER`, `VISION_MODEL`, `VISION_BASE_URL`, `VISION_API_KEY`, `VISION_MAX_PX`, `VISION_TIMEOUT_MS`, `VISION_REFRESH_MS`, `VISION_MAX_PER_HOUR`, `VISION_WHILE_ASLEEP`
- `assistant/relationships.ts` — How Tubs treats people he recognises (`config/relationships.json`, in git; folder `TUBS_CONFIG_DIR`; `GET/POST /relationships`; toggle `relationshipsEnabled`, on by default). The line rides with the current turn only (`context.ts`), never in history or field notes, and goes once the face page's `people` no longer name the person for `RELATIONSHIP_GRACE_MS` (10 s) or that page disconnects
- `memory/view.ts`, `routes/memory-routes.ts` — The memory view's data: one card per person (tonight's field notes, the face library's samples and photos, the relationship, in view or not), `GET /memory`; photos at `/memory/photo/<face id>` (the library keeps an 80 px JPEG per sample) and `/memory/snapshot/<visitor id>` (an unnamed visitor's first auto-onboarding snapshot, memory only like the notes). Admin actions are same-origin JSON POSTs (`/memory/forget {key}`, `/memory/library/remove {name}`, `/memory/clear`); all of it answers the local network only. A library removal broadcasts `faces_changed` so the face pages stop recognising that person. `TUBS_FACE_LIBRARY` moves the library file (tests)
- `presets/presets.ts`, `routes/preset-routes.ts` — Character presets: who the characters are (persona template inline, from a `.md` next to the preset, or the built-in one; the extra instruction; canned lines), a voice per head, the look (every `glitch*` setting and Small's colour) and behaviour (sleep timing, interruptible, two-head mode), in `config/presets/<name>.json` (`TUBS_CONFIG_DIR`, in git; `tubs.json` is the built-in character). `GET /presets`, `POST /presets {name}` saves the current state, `POST /presets/apply {name}` applies one live, all or nothing (config broadcast; no restart, the faces keep publishing). `GET /studio` lists them under `presets` (names, active)
- `llm/provider.ts` — Router: Gemini, or Ollama/OpenAI via the Python service (`LLM_PROVIDER` env); both stream
- `llm/gemini-client.ts` — Gemini API streaming with SSE
- `llm/providers/gemini.ts` — Structured generation wrapper
- `llm/providers/realtime.ts` — Gemini Realtime/Live API
- `processing/speech-service.ts` — Starts and supervises the Python speech service and the Ming TTS service
- `tts/stream.ts` — Streaming audio chunks to WebSocket
- `config/runtime.ts` — Runtime configuration, session stats
- `routes/api.ts` — REST: `/health`, `/stats`, `/config`, `/speak`, `/faces`, `/api/*`
- `recordings.ts` — Face-window video recordings, appended piece by piece; on stop ffmpeg re-encodes the video (Chrome's file freezes in QuickTime after the tab is resized) into a plain MP4 in `~/Movies/tubs-recordings` (`TUBS_RECORDINGS_DIR`), and Chrome's own file is kept in its `raw/`. `scripts/check-playback.swift` tells whether a video plays to the end in the Mac's decoder
- `studio/` — Studio mode (sentient-studio `docs/contract.md` §5-6), off by default (`TUBS_STUDIO`). `GET/POST /studio {enabled, site, micSource, visionSource}` (`routes/studio-routes.ts`; `GET /studio/snapshot` proxies a `snapshot:` source for the page); `GET /studio/sources` (`sources.ts`, contract §6 additive, for the Studio tab and the sentient panel): `{micSource, visionSource, mic: [...], vision: [...], suggested: {mic?, vision?}, problems: [...]}`, each entry `{value, label, kind: off|local|site|snapshot, ready, tracks?}`: `off`, `local` and the listener page's devices as `local:<label>` (its `studio_status.devices`; ready while it is connected; labels unlocked by opening each kind once for a moment, `client/studio/devices.ts`), the site node's paths with audio (mic) or video (vision), never `tubs-*` or `os-*` (mediamtx `/v3/paths/list`, ready = publishing), and with `FLEET_HUB` set the floor plan's placed depth cameras, `snapshot:<their service base>/api/snapshot/color.jpg` (ready = service healthy; a hub that does not answer adds nothing and no problem); `suggested` names the only ready remote source when the current one is not ready; the Studio tab asks on open and every 5 s; `state.ts` holds the settings and what the face pages report; each face page reports its render and publish cadence every 5 s (`client/studio/cadence.ts`; `GET /studio` `actors[].cadence`: render fps and largest gap, frames captured and encoded, encode ms per frame, encoded width, keyframes); keyframes come only when the site node asks (mediamtx: every 2 s), since forcing them by restarting the encoder held a frame each time; the WHIP answer gets `x-google-start-bitrate` so a new publish doesn't drop frames while the bitrate ramps; `launcher.ts` opens one system Chrome per head (own profile in the temp dir, closed on disable, on shutdown, and left over from a killed server via the profile's SingletonLock) unless `TUBS_STUDIO_LAUNCH=external`. Env: `TUBS_STUDIO_SITE` (site node, `http://127.0.0.1:8889`), `TUBS_MIC_SOURCE` (`local`, `local:<Chrome device label>`, `site:<path>`, `off`), `TUBS_VISION_SOURCE` (same, plus `snapshot:<url>`; default `off`), `TUBS_STUDIO_PREFIX` (`tubs-`), `TUBS_STUDIO_SIZE` (1024), `TUBS_STUDIO_PAGE_BASE`, `TUBS_STUDIO_CHROME`. `context.ts` turns the director's `studio_context` into a few lines of places for the prompt (dropped after 10 s, venue kept) and the call-out that opens a turn Tubs starts with someone not right at the window; the face pages hold a head's first line until the director's `studio_stage` says it is in place (at most `STAGE_WAIT_MAX_MS`, 2.5 s, `client/studio/stage.ts`)

### Python Service (`src/realtime-processing-service.py`)
- Flask app on port 3002, started and restarted by the server
- STT: `lightning-whisper-mlx` (Apple Silicon) or `faster-whisper` (CPU, int8). Clips in which Silero VAD (bundled with faster-whisper) finds under `REALTIME_VAD_MIN_SPEECH_MS` (250) of speech skip Whisper; transcripts Whisper scores as no speech are dropped too
- TTS: Kokoro (MLX on macOS, native elsewhere), streamed per sentence over `/tts/stream`; or system TTS (macOS `say`, pyttsx3 elsewhere)
- LLM proxy for Ollama / OpenAI-compatible models: `/llm/generate`, `/llm/stream`
- Endpoints: `/transcribe`, `/tts`, `/tts/stream`, `/llm/*`, `/health`
- Voices starting with `ming:` (`ming:friend` is main Tubs' cloned voice, `ming:friend-b` Mini's) are forwarded to a separate Ming TTS service at `MING_TTS_URL` (default `127.0.0.1:3003`), with the part after `ming:` as the voice name. When Ming is down or still loading, a `ming:` voice fails with Ming's reason (server log, and the turn's error in the transcript); it never switches to a Kokoro voice. With both heads on Ming, Kokoro isn't loaded. Start Tubs with `REALTIME_KOKORO_VOICE=ming:friend SECONDARY_VOICE=ming:friend-b DUAL_HEAD_ENABLED=true DUAL_HEAD_MODE=llm_directed`; runtime config does not survive a restart. Ming is `src/ming-tts-service.py`. It needs a newer mlx than STT, so it runs from its own venv, `venv-ming` (`npm run setup-ming`, pinned in `requirements-ming.txt`). The server starts and supervises it when that venv exists, unless something already listens on `MING_PORT` (3003). Its voice references are recordings of a real person and stay out of git, in `data/ming-voices/` (`MING_VOICE_DIR`); the listening tests behind its settings are in `~/Movies/tubs-voice-lab/`. Its output gets a warmer EQ per voice (`src/ming_eq.py`, the user's pick from the voice lab), filtered chunk by chunk with the state carried over. Ming gets whole replies, not sentences, and streams each back in chunks from its `/tts/stream` as it renders (falls back to its `/tts` if that route is missing). The chunks of one reply carry the same text, all but the last flagged `more`; the client plays them back to back under one subtitle, in a 24 kHz AudioContext so the mid-word cuts join sample for sample.

### Client (`src/client/`) — React + TypeScript + Zustand

**Entry:** `main.ts` → `bootstrap-react.tsx` (initializes runtimes, React root)

Two build entries: `index.html` (main) and `app-mini.html` (mini display mode). Pages are cross-origin isolated (COOP/COEP `credentialless`, in `vite.config.ts` and `src/server/http/static.ts`) so the face worker (`src/workers/face-worker.ts`, SCRFD det_10g + ArcFace R50 on onnxruntime-web) runs on up to 8 WASM threads; the benchmark behind it is in `~/Movies/tubs-face-lab/`. `/?view=dashboard` is the operator HUD for a separate screen (no face, no audio, mic or camera); `app-mini.html?embed=1` is the mini tile inside the face window. The dashboard's Studio tab (`ui/panels/StudioPanel.tsx`) runs the studio: studio mode, mic and vision sources, the vision provider, each head's stream, presets and the relationships list; it works inside the sentient panel's cross-origin iframe. `/?view=memory` is the memory view on its own (`memory-page.tsx`, HTTP only); the dashboard has it as the Memory tab (`ui/panels/MemoryPanel.tsx`). `studio-face.html?actor=main|small[&size=1024][&monitor=1]` is one head for the studio (`studio/runtime.ts`): face alone on black, drawn at most 60 fps (`STUDIO_RENDER_MAX_FPS`; it is published at 30), canvas plus that head's voice published over WHIP to `<site>/tubs-<actor>/whip` (`studio/publisher.ts`, `transport/whip.ts`), gaze and presence from the director. The main one is also the listener (mic, sleep, proactive); while studio mode is on the operator face lets go of its mic.

**Runtime-based architecture** — each subsystem is a standalone runtime with `init()`, `bind()`, `dispose()`:

- `audio/speech-runtime.ts` — Server audio playback (streaming queue), subtitle timing. `audio/streaming-session.ts` plays one turn's chunks back to back; a reply still arriving (Ming's `more`) starts only once enough of it is here to play through at the measured delivery rate (Ming renders at ~0.4x under GPU load; `STREAM_MAX_HOLD_MS`), and a line never ends while more of it was promised, so a stalled reply stays one subtitle and one studio caption
- `audio/screen-recorder.ts` — Record button / R key: this tab's video and audio plus the mic, mixed, uploaded to the server each second
- `audio/voice-runtime.ts` — Mic input + VAD (push-to-talk + hands-free). With the Interruptible toggle (config `interruptible`, Voice panel; off by default), talking over Tubs or Mini cuts them off hands-free; off, the mic ignores speech while a head talks
- `audio/ambient-runtime.ts` — Background sounds
- `face/runtime.ts` — Face shell, camera input, face detection
- `face/behavior-runtime.ts` — Expression & animation synced with speech. The studio director's look is followed smoothly while it moves (`face/gaze.ts` pursuit) and held with fixations, micro-saccades and glances once it is steady
- `glitch/runtime.ts` — Pixel face with glitch effects (WebGPU only)
- `fx/runtime.ts` — Visual effects (filters, overlays)
- `behavior/emotion-runtime.ts` — Emotional state: the face window's mood, and each studio head's own (impulses from that head's lines; two-head `audio_chunk`s carry their line's emotion)
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

**Client → Server:** `ping`, `incoming`, `interrupt`, `face_motion`, `face_blink`, `head_speech_state`, `presence`, `camera_frame`, `appearance_frame`, `tts_request`; studio mode: `studio_look`, `studio_presence`, `studio_context`, `studio_stage` (director, ignored while studio mode is off), `studio_state`, `studio_status`, `studio_caption` (face pages, `/ws?studio=<actor>`)

**Server → Client:** `ping`, `config`, `system`, `expression`, `faces_changed`, `thinking`, `speak`, `speak_chunk`, `speak_end`, `audio_chunk`, `turn_start`, `turn_script`, `turn_context`, `interrupt`, `backchannel`, `incoming`, `donation_signal`, `stats`, `stream_debug`, `conversation_mode`, `sleep`, `wake`, `error`, `face_motion`, `face_blink`, `head_speech_state`; studio mode: `studio_config` (face pages, and other pages while studio mode is on), `studio_look`, `studio_presence`, `studio_stage` (face pages only), `studio_state`, `studio_caption` (everyone; the line a head says and how many of its characters have been heard, from its page's playback clock, `studio/caption.ts`)

## Key Patterns

- **Runtime composition** — features are standalone runtimes, not class hierarchies
- **Streaming-first** — audio chunks streamed incrementally (not full responses)
- **Dual-head** — structured multi-beat responses with different actors/actions
- **Broadcast model** — server broadcasts all messages to all connected WS clients
- Requires `GEMINI_API_KEY` env var

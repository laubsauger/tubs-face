# Agent Configuration

This document describes the active persona and runtime behavior for the Tubs face interface.

## Current Agent: Tubs

- Model label: `Tubs Bot v1`
- Role: Animated chatbot face interface
- Personality: Helpful, slightly robotic, friendly, expressive

## Runtime Configuration

The bridge server keeps mutable runtime config in `src/bridge-server.js` and exposes it over `/config`.

Default runtime config:

```json
{
  "sleepTimeout": 300000,
  "model": "Tubs Bot v1",
  "prompt": "Default personality"
}
```

## Active Capabilities

- Speech output:
  - Primary path: `POST /tts` on the bridge, proxied to Python service on port `3001`.
  - Frontend playback: returned WAV audio.
  - Fallback: browser `SpeechSynthesis` if TTS service fails.
- Listening / voice input:
  - Browser captures audio (`MediaRecorder` + Web Audio visualization).
  - Audio is sent to `POST /voice` on the bridge.
  - Bridge forwards audio to Python `/transcribe` (Whisper via `faster-whisper`).
  - Optional wake-word gate is supported via `/voice?wakeWord=true`.
- Expressions:
  - `idle`: Neutral state.
  - `listening`: Alert, awaiting or receiving input.
  - `thinking`: Processing state, loading bar active.
  - `speaking`: Mouth animation during playback.
  - `sleep`: Sleep visuals (dimmed UI, eyes closed).
  - Also supported by UI state machine: `smile`, `happy`.

## Bridge API Surface

Implemented in `src/bridge-server.js`:

- `GET /` serve UI
- `GET /health` health + connected clients
- `GET /stats` session stats
- `POST /speak` inject speech text to UI
- `POST /voice` upload recorded audio for STT + response flow
- `POST /tts` proxy TTS request to Python service
- `POST /sleep` enter sleep mode
- `POST /wake` wake mode
- `POST /config` update runtime config

## Adding / Changing Agents

1. Update `runtimeConfig` in `src/bridge-server.js` (or send `POST /config`).
2. Update response behavior in `generateDemoResponse` or replace with a real LLM backend.
3. If voice/TTS behavior changes, update both:
   - `public/js/main.js`
   - `src/transcription-service.py`

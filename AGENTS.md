# Agent Configuration

This document describes the active persona and runtime behavior for the Tubs face interface.

## Current Agent: Tubs

- Model label: `Tubs Bot v1`
- Role: Animated chatbot face interface
- Personality: Cute tub-robot with slight maniac energy; mission-driven fundraiser for electric wheels and Rapha's Thailand vacation

## Runtime Configuration

The bridge server keeps mutable runtime config in `src/config.js` and exposes it over `/config`.

Default runtime config:

```json
{
  "sleepTimeout": 10000,
  "model": "Tubs Bot v1",
  "prompt": "Default personality",
  "sttModel": "small",
  "llmModel": "gemini-2.5-flash",
  "llmMaxOutputTokens": 120
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
- `GET /config` read runtime config
- `POST /config` update runtime config

## Adding / Changing Agents

1. Update `runtimeConfig` in `src/config.js` (or send `POST /config`).
2. Edit persona behavior in:
   - `src/persona/system-prompt.txt`
   - `src/persona/greetings.json`
   - `.env` (`DONATION_VENMO`, `DONATION_QR_DATA`, optional Gemini pricing for cost estimates)
3. If voice/TTS behavior changes, update both:
   - `public/js/audio-input.js`
   - `src/transcription-service.py`

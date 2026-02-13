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
  "llmMaxOutputTokens": 256,
  "donationSignalMode": "both",
  "faceRenderMode": "svg",
  "dualHeadEnabled": false,
  "dualHeadMode": "off",
  "secondaryVoice": "am_puck",
  "secondarySubtitleEnabled": false,
  "secondaryAudioGain": 0.9,
  "dualHeadTurnPolicy": "llm_order"
}
```

## Active Capabilities

- Speech output:
  - Primary path: `POST /tts` on the bridge, proxied to Python service on port `3001`.
  - Frontend playback: returned WAV audio.
  - Fallback: browser `SpeechSynthesis` if TTS service fails.
- Conversational replies:
  - Primary path: Gemini `generateContent` via `src/assistant-service.js`.
  - Fast-path greetings come from `src/persona/greetings.json` without an LLM roundtrip.
  - Short rolling memory and token/cost accounting are included in session stats.
  - Replies may append one supported trailing emoji token, which maps to face emotion cues.
  - Supported emoji cues: `🙂`, `😄`, `😏`, `🥺`, `😢`, `😤`, `🤖`, `🫶`.
  - Optional dual-head mode: one LLM call can return an ordered `turn_script` (`main` + `small` beats). Main window renders `main`; `mini.html` renders `small`.
- Listening / voice input:
  - Browser captures audio (`MediaRecorder` + Web Audio visualization).
  - Audio is sent to `POST /voice` on the bridge.
  - Bridge forwards audio to Python `/transcribe` (Whisper via `faster-whisper`).
  - Optional wake-word gate is supported via `/voice?wakeWord=true`.
- Expressions:
  - `idle`: Neutral state.
  - `idle-flat`: Occasional flatter neutral variant.
  - `listening`: Alert, awaiting or receiving input.
  - `thinking`: Processing state, loading bar active.
  - `speaking`: Mouth animation during playback.
  - `love`: Donation joy (heart-eyes, happy/laughing mouth).
  - `crying`: Sad/teary reaction when someone leaves without donating (occasional).
  - `sleep`: Sleep visuals (dimmed UI, eyes closed).
  - Also supported by UI state machine: `smile`, `happy`.
- Donation visuals:
  - When a response requests donations, the frontend shows a Venmo QR card.
  - User donation confirmations/pledges can trigger a short `love` expression.
  - Signal mode is configurable (`both`, `implied`, `confident`, `off`).

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
- `GET /shapes/:name.svg` serve source SVG shape assets from `src/shapes`
- `GET /config` read runtime config
- `POST /config` update runtime config
- `POST /checkout/paypal/order` create a PayPal order (optional checkout path)
- `POST /checkout/paypal/capture` capture a PayPal order and emit confident donation signal on completion
- `POST /donations/confirm` push manual donation signal to UI (`implied` or `confident`)
- `POST /webhooks/paypal` receive PayPal webhook events and map supported events to donation signals

## Adding / Changing Agents

1. Update `runtimeConfig` in `src/config.js` (or send `POST /config`).
2. Edit persona behavior in:
   - `src/persona/system-prompt.txt`
   - `src/persona/greetings.json`
   - `.env` (`DONATION_VENMO`, `DONATION_QR_DATA`, optional Gemini pricing for cost estimates)
3. If voice/TTS behavior changes, update both:
   - `public/js/audio-input.js`
   - `src/transcription-service.py`

# Processing Mode Migration Plan

## Objective
Add a second, selectable processing mode that uses a different STT/TTS/LLM stack, while keeping the current stack fully intact and default.

## Scope
- In scope:
  - Two startup-selectable processing modes:
    - `legacy` (current behavior)
    - `realtime` (new stack inspired by `jeantimex/RealtimeVoiceChat` `mac-support`)
  - Mode-aware STT, TTS, and LLM routing.
  - New `package.json` scripts for mode selection.
  - Documentation and verification checklist.
- Out of scope (phase 1):
  - Rebuilding frontend protocol/UI behavior.
  - Runtime hot-switching modes after process start.
  - Replacing existing donation/dual-head logic.

## Current Baseline (must remain unchanged by default)
- Node bridge starts in `src/bridge-server.js` and spawns Python STT/TTS via `src/python-service.js`.
- STT/TTS calls flow through `src/routes.js`:
  - `/voice` and `/voice/segment` -> `transcribeAudio(...)`
  - `/tts` -> proxy to Python `/tts`
- LLM currently lives in Node (`src/assistant/generate.js` + `src/gemini-client.js`).
- Runtime config is served by `/config` (`src/config.js`, `src/routes.js`).

## Proposed Architecture

### 1) Boot-Time Mode Selector
- Add `PROCESSING_MODE` env with allowed values: `legacy`, `realtime`.
- Default: `legacy`.
- Add startup validation and log mode at boot.

### 2) Processing Mode Facade
- Create a narrow interface the bridge uses, for example:
  - `start()`
  - `stop()`
  - `transcribeAudio(audioBuffer, mimeType)`
  - `synthesizeSpeech(ttsPayload)` (or passthrough/proxy helper)
  - `llmGenerate(request)`
  - `llmStream(request)`
- Implement two adapters:
  - `legacy` adapter:
    - reuses existing Python service + Gemini client.
  - `realtime` adapter:
    - routes STT/TTS/LLM through new stack service/components.

### 3) LLM Provider Decoupling
- Extract Gemini-specific calls behind provider interface (no behavior changes first).
- Update `src/assistant/generate.js` to call provider methods rather than importing `gemini-client` directly.
- Keep streaming semantics (`speak_chunk`, `speak_end`) stable for frontend compatibility.

### 4) Realtime Stack Integration
- Build a new backend path for `realtime` mode (new Python service module is recommended).
- Initial provider targets from `RealtimeVoiceChat mac-support`:
  - STT: `RealtimeSTT`
  - TTS: `RealtimeTTS` (use mac-safe engine defaults)
  - LLM: `ollama`/`openai`/`lmstudio` style provider abstraction
- Keep Node API contract unchanged (`/voice`, `/tts`, websocket events).

## Execution Plan (Tasks)

### Status Snapshot (2026-02-15)
- Completed in this repo:
  - Boot-time `PROCESSING_MODE` contract (`legacy`/`realtime`) with default `legacy`.
  - New mode manager scaffold and mode adapters:
    - `src/processing/mode-manager.js`
    - `src/processing/modes/legacy.js`
    - `src/processing/modes/realtime.js` (wired to dedicated realtime service)
  - Bridge + route wiring through mode manager for STT lifecycle/transcription and TTS proxy target.
  - `processingMode` exposed in `/health` and `/config`.
  - `processingMode` blocked in `POST /config` (startup-only).
  - `package.json` startup scripts for `start:legacy` and `start:realtime`.
  - LLM provider abstraction:
    - `src/llm/provider.js`
    - `src/llm/providers/gemini.js`
    - `src/llm/providers/realtime.js`
    - `src/assistant/generate.js` now uses provider interface instead of direct Gemini client calls.
  - Dedicated realtime service path:
    - `src/realtime-service.js` (Node process + HTTP client)
    - `src/realtime-processing-service.py` (`/transcribe`, `/tts`, `/llm/generate`, `/llm/stream`)
  - Realtime conversational LLM path is fail-fast: no hidden demo/provider fallback; explicit error when provider/model is missing.
- Not completed yet:
  - Full regression checklist automation for both modes.
  - Mode-specific runtime config schema hardening for all provider-specific fields.

### Phase 0: Contract + Guardrails
- [x] Define mode names and env contract (`PROCESSING_MODE`).
- [ ] Write compatibility contract doc for unchanged external APIs/events.
- [ ] Decide ownership of LLM in realtime mode (recommended: mode adapter decides, assistant logic remains shared).
- Exit criteria:
  - mode contract approved.
  - no external API changes required for UI.

### Phase 1: Introduce Mode Manager (No Functional Change)
- [x] Add `src/processing/mode-manager.js` and `src/processing/modes/legacy.js`.
- [x] Wire `src/bridge-server.js` to resolve mode and initialize through mode manager.
- [x] Keep all behavior identical in `legacy`.
- [x] Surface active mode in `/health` and `/config` response payload.
- Exit criteria:
  - `npm start` behavior unchanged.
  - startup logs show `mode=legacy`.

### Phase 2: Extract LLM Provider Interface
- [x] Add `src/llm/provider.js` interface and `src/llm/providers/gemini.js`.
- [x] Add realtime provider `src/llm/providers/realtime.js`.
- [x] Refactor `src/assistant/generate.js` to consume provider.
- [ ] Add adapter tests/mocks for:
  - non-streaming response
  - streaming response
  - provider error fallback path
- Exit criteria:
  - legacy mode still uses Gemini and passes smoke test flows.

### Phase 3: Add Realtime Mode Service Layer
- [x] Add new runtime service for realtime mode (`src/realtime-processing-service.py`).
- [x] Implement endpoints for parity:
  - `/health`
  - `/transcribe`
  - `/tts`
  - `/llm/generate`
  - `/llm/stream`
- [x] Add node adapter `src/processing/modes/realtime.js` that talks to this service.
- [x] Ensure process lifecycle management mirrors current Python service startup/shutdown/restart behavior.
- Exit criteria:
  - realtime mode can complete one full voice -> text -> llm -> tts turn (manual smoke done; deeper validation pending).

### Phase 4: Runtime Config and Validation
- [ ] Add mode-specific config schema:
  - `legacy`: existing fields
  - `realtime`: provider/engine/model fields
- [x] Prevent runtime `processingMode` mutation at `/config` (startup-only guard).
- [ ] Prevent invalid cross-mode fields at `/config` for provider-specific fields.
- [ ] Decide immutable vs mutable fields for mode safety (recommended: mode immutable after boot).
- Exit criteria:
  - `/config` updates are validated deterministically per mode.

### Phase 5: Startup Scripts + Environment
- [x] Add scripts:
  - `start:legacy`
  - `start:realtime`
  - keep `start` mapped to `start:legacy`
- [x] Add `.env.example` mode section.
- [ ] Document dependency split:
  - existing requirements for legacy
  - additional realtime dependencies (or separate requirements file).
- Exit criteria:
  - one-command startup for each mode from `package.json`.

### Phase 6: Verification + Rollout Safety
- [ ] Build a regression checklist for legacy:
  - `/voice`, `/voice/segment`, `/tts`, websocket chat, proactive, donation signals, dual-head.
- [ ] Build realtime checklist:
  - STT accuracy sanity, TTS returns WAV, LLM streaming, interruption behavior.
- [ ] Add a smoke test script (bash/node) to hit `/health`, `/config`, `/tts`, and a text chat path.
- [ ] Rollout plan:
  - merge scaffolding first
  - merge realtime mode behind explicit script/env
  - keep default on legacy until realtime burn-in passes.
- Exit criteria:
  - legacy verified unchanged.
  - realtime stable behind explicit startup script.

## File-Level Change Plan
- Add:
  - `src/processing/mode-manager.js`
  - `src/processing/modes/legacy.js`
  - `src/processing/modes/realtime.js`
  - `src/llm/provider.js`
  - `src/llm/providers/gemini.js`
  - `src/llm/providers/realtime.js`
  - `src/realtime-processing-service.py` (or equivalent service module)
  - `docs/processing-mode-runbook.md` (operational guide)
- Update:
  - `src/bridge-server.js`
  - `src/routes.js`
  - `src/python-service.js` (or split into mode-specific service manager)
  - `src/assistant/generate.js`
  - `src/config.js`
  - `package.json`
  - `.env.example`
  - `README.md`

## Risks and Mitigations
- Risk: hidden coupling between assistant logic and Gemini response format.
  - Mitigation: provider interface with normalization layer + adapter tests.
- Risk: realtime service dependencies are heavier and platform-sensitive.
  - Mitigation: isolate dependencies by mode, keep legacy requirements untouched.
- Risk: regressions in audio turn timing.
  - Mitigation: preserve existing websocket event contract and timing hooks.
- Risk: runtime config conflicts across modes.
  - Mitigation: mode-scoped validation and explicit error messages.

## Definition of Done
- Two startup-selectable modes exist.
- `legacy` mode remains default and behaviorally equivalent.
- `realtime` mode completes end-to-end voice loop using its own STT/TTS/LLM stack.
- README + runbook explain setup, scripts, env, and troubleshooting for both modes.

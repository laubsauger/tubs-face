# TypeScript Migration Tickets

## Usage

Each ticket is intended to be owned by one agent. Do not start a ticket until its dependencies are merged or explicitly vendored into your branch.

Each ticket includes:

- scope
- exact file targets
- dependencies
- deliverables
- acceptance criteria
- handoff notes

## Global Rules

1. Do not add new code to legacy JS files unless the ticket explicitly says to.
2. New shared types go in `src/shared/`, not inside feature folders.
3. If a ticket changes a runtime payload shape, update the shared contract in the same branch.
4. Prefer moving code into final directories over doing temporary in-place rewrites.
5. Python may stay. Only type the boundary unless the ticket explicitly calls for evaluation.

## T0: Platform Scaffold

Owner:

- Agent 1

Dependencies:

- none

Scope:

- create the new TS/ESM/Vite skeleton
- make the repo capable of hosting the migrated code

File targets:

- `package.json`
- `tsconfig.json`
- `tsconfig.node.json`
- `vite.config.ts`
- `src/client/main.ts`
- `src/client/mini-main.ts`
- `src/server/index.ts`
- `src/shared/`
- `src/workers/`
- `src/scripts/`

Deliverables:

- Vite client entrypoints
- TS server entrypoint runnable with `tsx`
- ESM package config
- base npm scripts for `dev`, `build`, `typecheck`, `test`
- placeholder source tree

Acceptance criteria:

- [ ] `npm run dev:client` starts
- [ ] `npm run dev:server` starts
- [ ] `npm run typecheck` runs successfully on the scaffold
- [ ] `package.json` is on ESM
- [ ] Vite can serve a placeholder main app and mini app

Do not touch:

- legacy feature behavior
- Python services
- legacy JS module internals except where imports/scripts must be repointed

Handoff notes:

- publish final directory layout
- publish npm scripts
- publish alias decisions
- tell all other agents where entrypoints live

## T1: Shared Contracts

Owner:

- Agent 2

Dependencies:

- T0

Scope:

- define shared runtime contracts before feature rewrites diverge

File targets:

- `src/shared/contracts/config.ts`
- `src/shared/contracts/ws.ts`
- `src/shared/contracts/http.ts`
- `src/shared/contracts/turn-script.ts`
- `src/shared/contracts/faces.ts`
- `src/shared/contracts/worker.ts`
- `src/shared/guards/`

Legacy files to read from:

- `src/config.js`
- `src/routes.js`
- `src/websocket.js`
- `public/js/message-handler.js`
- `public/js/websocket.js`
- `public/js/mini-main.js`
- `public/js/face-worker.js`

Deliverables:

- config enums and string unions
- client/server WS message unions
- HTTP request/response types
- turn-script types
- face library and recognition types
- worker message types
- runtime guards for untrusted payloads

Acceptance criteria:

- [ ] all currently used WS message types are represented
- [ ] all major HTTP endpoints have typed payloads
- [ ] worker message directions are typed
- [ ] no duplicate protocol definitions appear outside `src/shared/`

Do not touch:

- runtime behavior
- server/client entrypoint wiring

Handoff notes:

- publish a short map of canonical imports, for example `@shared/contracts/ws`
- publish unresolved protocol ambiguities if found

## T2: Server Core Rewrite

Owner:

- Agent 3

Dependencies:

- T0
- T1

Scope:

- build the new TS server core and move active backend logic onto it

File targets:

- `src/server/index.ts`
- `src/server/config/*`
- `src/server/routes/*`
- `src/server/ws/*`
- `src/server/lib/*`

Legacy files to replace/mine:

- `src/bridge-server.js`
- `src/routes.js`
- `src/websocket.js`
- `src/config.js`
- `src/env.js`
- `src/logger.js`
- `src/turn-timing.js`
- `src/face-library.js`

Deliverables:

- bootable TS server
- typed request parsing
- typed WS broadcast/send handling
- config/runtime normalization modules
- extracted route helpers

Acceptance criteria:

- [ ] TS server can boot
- [ ] `/health`, `/stats`, `/config` work from the new server path
- [ ] WS server accepts connections from the new client shell
- [ ] active server path does not use CommonJS

Do not touch:

- assistant generation internals beyond what is needed to wire the server
- browser UI code except contract alignment

Handoff notes:

- document any endpoints still routed through legacy modules
- list remaining server-side modules still needing migration

## T3: Assistant and Processing Migration

Owner:

- Agent 3 or a second backend agent

Dependencies:

- T0
- T1
- T2

Scope:

- move server-side assistant, provider, and processing orchestration into TS

File targets:

- `src/server/assistant/*`
- `src/server/llm/*`
- `src/server/processing/*`
- `src/server/integrations/*`

Legacy files to replace/mine:

- `src/assistant-service.js`
- `src/assistant/*.js`
- `src/llm/provider.js`
- `src/llm/providers/*.js`
- `src/processing/mode-manager.js`
- `src/processing/modes/*.js`
- `src/gemini-client.js`
- `src/paypal-client.js`
- `src/langfuse.js`
- `src/python-service.js`
- `src/realtime-service.js`
- `src/wake-word.js`

Deliverables:

- typed assistant pipeline
- typed provider interfaces
- typed processing mode orchestration
- typed Python service boundary

Acceptance criteria:

- [ ] voice and assistant generation paths run through TS modules
- [ ] provider responses are typed
- [ ] processing mode adapter interface is typed
- [ ] Python subprocess/http boundaries are typed

Do not touch:

- browser-side TTS/audio playback behavior except payload compatibility

Handoff notes:

- publish typed interfaces that client-facing teams depend on
- call out any performance-sensitive sections left intentionally unchanged

## T4: Client Shell

Owner:

- Agent 4

Dependencies:

- T0
- T1

Scope:

- build the new browser shell and runtime spine in TypeScript

File targets:

- `src/client/main.ts`
- `src/client/mini-main.ts`
- `src/client/state/*`
- `src/client/transport/*`
- `src/client/dom/*`
- `src/client/runtime/*`

Legacy files to replace/mine:

- `public/js/main.js`
- `public/js/mini-main.js`
- `public/js/state.js`
- `public/js/websocket.js`
- `public/js/dom.js`
- `public/js/message-handler.js`
- `public/js/message-handler-utils.js`

Deliverables:

- Vite-based main app shell
- Vite-based mini app shell
- typed client state
- typed WS client
- typed message dispatch pipeline

Acceptance criteria:

- [ ] main window boots
- [ ] mini window boots
- [ ] client connects to TS server over WS
- [ ] config/stats/system messages apply through typed handlers

Do not touch:

- deep face pipeline internals
- audio capture internals
- glitch/FX details

Handoff notes:

- publish stable state shape
- publish message dispatch APIs that downstream client tickets should use

## T5: Client Audio and Speech

Owner:

- Agent 5

Dependencies:

- T0
- T1
- T4
- T3 for final contract alignment

Scope:

- migrate microphone, VAD, TTS playback, subtitles, transcript UI

File targets:

- `src/client/audio/*`
- `src/client/transcript/*`

Legacy files to replace/mine:

- `public/js/audio-input.js`
- `public/js/tts.js`
- `public/js/tts-text.js`
- `public/js/subtitles.js`
- `public/js/live-user-transcript.js`
- `public/js/ambient-audio.js`

Deliverables:

- typed mic and VAD flow
- typed TTS queue/playback flow
- typed transcript/subtitle modules

Acceptance criteria:

- [ ] push-to-talk works
- [ ] VAD mode works
- [ ] TTS queue and streamed audio handling work
- [ ] transcript/subtitle UI still functions

Do not touch:

- server-side generation logic except contract mismatches
- face pipeline internals

Handoff notes:

- document expected audio-related message/event flows
- note any browser API typing pain points

## T6: Face Pipeline and Worker

Owner:

- Agent 6

Dependencies:

- T0
- T1
- T4

Scope:

- migrate camera, detection, recognition, enrollment, results, and the face worker

File targets:

- `src/client/face/*`
- `src/workers/face-worker.ts`

Legacy files to replace/mine:

- `public/js/face/index.js`
- `public/js/face/library.js`
- `public/js/face/results.js`
- `public/js/face/detection.js`
- `public/js/face/camera.js`
- `public/js/face/debug.js`
- `public/js/face/greetings.js`
- `public/js/face/enrollment.js`
- `public/js/face/ingest.js`
- `public/js/face/math.js`
- `public/js/eye-tracking.js`
- `public/js/vision-capture.js`
- `public/js/face-worker.js`

Deliverables:

- typed face pipeline modules
- TypeScript module worker
- typed worker message bridge

Acceptance criteria:

- [ ] camera start/stop works
- [ ] face detection still runs
- [ ] recognition/enrollment still work
- [ ] worker loads through Vite as TS module worker
- [ ] no JS worker remains in the active path

Do not touch:

- general app shell outside face integration points

Handoff notes:

- publish worker creation API
- publish worker message types actually in use

## T7: UI Behavior and FX

Owner:

- Agent 7

Dependencies:

- T0
- T1
- T4

Scope:

- migrate non-face client behavior, renderer control, UI interaction, and FX

File targets:

- `src/client/ui/*`
- `src/client/behavior/*`
- `src/client/fx/*`

Legacy files to replace/mine:

- `public/js/expressions.js`
- `public/js/emotion-engine.js`
- `public/js/idle-behavior.js`
- `public/js/sleep.js`
- `public/js/panel-ui.js`
- `public/js/fullscreen.js`
- `public/js/donation-ui.js`
- `public/js/proactive.js`
- `public/js/perf-hooks.js`
- `public/js/perf-stats.js`
- `public/js/stream-debug.js`
- `public/js/manual-beats.js`
- `public/js/fx-editor.js`
- `public/js/turn-script.js`
- `public/js/turn-timing.js`
- `public/js/face-renderer.js`
- `public/js/glitch-fx.js`
- `public/js/glitch-fx/*.js`
- `public/js/mini/*.js`

Deliverables:

- typed UI behavior modules
- typed renderer control path
- typed FX modules

Acceptance criteria:

- [ ] sleep/wake works
- [ ] expressions and emotion updates work
- [ ] dual-head UI controls work
- [ ] glitch FX path still renders
- [ ] no plain-JS UI behavior module remains in active startup path

Do not touch:

- face recognition internals
- core transport contracts

Handoff notes:

- document any remaining tight couplings to client state

## T8: Scripts and Non-Critical Demo Code

Owner:

- Agent 8

Dependencies:

- T0

Scope:

- migrate local JS scripts and make a call on non-critical demo code

File targets:

- `src/scripts/*`
- optionally `docs/Glitch Tool/*`

Legacy files to replace/mine:

- `scripts/benchmark-llm.js`
- `docs/Glitch Tool/script.js`
- `docs/Glitch Tool/config.js`

Deliverables:

- TS benchmark script
- recommendation on docs demo: migrate or archive

Acceptance criteria:

- [ ] benchmark script runs from TS toolchain
- [ ] docs demo decision is documented
- [ ] if demo is retained, its JS is migrated

Do not touch:

- app runtime code unless shared utility extraction is necessary

Handoff notes:

- clearly state whether demo code remains in migration scope

## T9: Python Boundary Evaluation

Owner:

- Agent 9

Dependencies:

- T1
- T2
- T3

Scope:

- answer the Python questions with evidence and make sure TS-side boundaries are fully typed

File targets:

- `docs/typescript-python-evaluation.md`
- any TS-side service contract files under `src/shared/contracts/` or `src/server/processing/`

Legacy files to inspect:

- `src/transcription-service.py`
- `src/realtime-processing-service.py`
- `src/python-service.js`
- `src/realtime-service.js`
- `src/processing/modes/*.js`
- `scripts/setup-python.sh`
- `requirements.txt`

Deliverables:

- typed Python boundary contracts
- decision memo: keep vs replace per Python component
- performance and ops tradeoff summary

Acceptance criteria:

- [ ] STT/TTS/realtime boundaries are documented
- [ ] keep-vs-replace recommendation exists for each Python service
- [ ] no rewrite is recommended without a concrete upside

Do not touch:

- production Python runtime unless the ticket is explicitly expanded

Handoff notes:

- publish recommendations per subsystem, not a single blanket answer

## T10: Cutover and Cleanup

Owner:

- Agent 10 or integrator

Dependencies:

- T2
- T3
- T4
- T5
- T6
- T7
- T8

Scope:

- switch the repo to the new stack and remove dead legacy JS paths

File targets:

- `package.json`
- `README.md`
- legacy JS entrypoints under `src/` and `public/js/`

Deliverables:

- new default scripts
- updated docs
- dead JS removed from active path

Acceptance criteria:

- [ ] `npm run dev` starts the new stack
- [ ] `npm run build` succeeds
- [ ] `npm run typecheck` succeeds
- [ ] active runtime no longer depends on legacy JS entrypoints
- [ ] README describes the new workflow

Do not touch:

- Python runtime decisions beyond what T9 settled

Handoff notes:

- list any intentionally retained legacy files that are still non-runtime

## Suggested Start Order

Start immediately:

1. T0 Platform Scaffold
2. T1 Shared Contracts

Start as soon as dependencies land:

3. T4 Client Shell
4. T2 Server Core Rewrite

Start after shell/core stabilize:

5. T3 Assistant and Processing Migration
6. T5 Client Audio and Speech
7. T6 Face Pipeline and Worker
8. T7 UI Behavior and FX
9. T8 Scripts and Non-Critical Demo Code
10. T9 Python Boundary Evaluation

Finalize:

11. T10 Cutover and Cleanup

## Minimum Cross-Ticket Handoffs

T0 must publish:

- final source tree
- npm scripts
- alias configuration

T1 must publish:

- canonical contract import paths
- any unresolved payload ambiguities

T2 and T4 must publish:

- stable integration points for downstream agents

T9 must publish:

- subsystem-by-subsystem Python recommendation

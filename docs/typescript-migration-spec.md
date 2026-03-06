# TypeScript Migration Execution Spec

## Goal

Move all JavaScript application code in this repo to TypeScript with a clean source layout and a modern build pipeline.

This includes:

- browser app code
- Node server code
- all JS workers
- all JS scripts

This does not require replacing Python if Python remains the better implementation for STT/TTS or realtime processing.

## Decisions

These are no longer open questions.

### Final architecture

- Browser app source lives in `src/client/`
- Server source lives in `src/server/`
- Shared contracts and types live in `src/shared/`
- Worker source lives in `src/workers/`
- Local TS scripts live in `src/scripts/`
- `public/` is static assets only

### Tooling

- Browser build/dev: `vite`
- Server dev runtime: `tsx`
- Server build: `tsc`
- Typecheck: `tsc --noEmit`
- Tests: `vitest`
- Module system: ESM
- `package.json` moves to `"type": "module"`

### Python policy

- Keep Python for now
- Type the Python boundaries on the TS side
- Revisit replacement only after benchmarking and only if the JS/TS alternative is not worse

### Worker policy

- All JS workers must become TypeScript
- Browser workers move to module workers managed by Vite

### CSS policy

- Do not block the migration on CSS reorganization
- Keep CSS/assets working first
- Move CSS imports into the Vite app only where it simplifies the client rewrite

### Docs demo policy

- `docs/Glitch Tool/*` is not on the critical path
- Migrate it later or archive it
- Do not let it block the main app migration

## Success Criteria

- [ ] No application JS source remains in `src/`, `public/js/`, or `scripts/`
- [ ] All browser entrypoints run from TypeScript source under `src/client/`
- [ ] All server entrypoints run from TypeScript source under `src/server/`
- [ ] All JS workers run from TypeScript source under `src/workers/`
- [ ] Shared contracts are centralized under `src/shared/`
- [ ] `public/` no longer contains application source code
- [ ] `npm run dev` boots the new stack
- [ ] `npm run build` succeeds
- [ ] `npm run typecheck` succeeds with zero errors

## Execution Rules

These rules are what make the work parallelizable.

1. No new feature work in legacy JS files once a TS replacement track exists.
2. Shared contracts are the source of truth. Do not duplicate message or payload types inside feature modules.
3. Agents should avoid in-place `.js -> .ts` rewrites in legacy folders when the final destination is a new `src/*` tree.
4. Each task must name:
   - inputs
   - outputs
   - dependencies
   - acceptance criteria
5. Any task that changes message payloads must update the shared contract package in the same branch.

## Migration Order

There are three blocking milestones. Everything else hangs off them.

### Milestone A: Platform scaffold

Create the new TS/ESM/Vite skeleton so feature work can move into it.

### Milestone B: Shared contracts

Define the runtime boundaries so multiple agents can migrate features without inventing incompatible types.

### Milestone C: App cutover

Switch runtime entrypoints from legacy JS paths to the new TS build outputs.

## Workstreams

These are the parallel tracks. Each workstream can be handled by a separate agent once its dependencies are met.

### WS0: Platform scaffold

Status: blocking

Dependencies:

- none

Outputs:

- `tsconfig.json`
- `vite.config.ts`
- updated `package.json`
- `src/client/`
- `src/server/`
- `src/shared/`
- `src/workers/`
- `src/scripts/`
- dev/build/typecheck scripts

Acceptance criteria:

- [ ] `npm run typecheck` runs
- [ ] `npm run dev:client` runs
- [ ] `npm run dev:server` runs
- [ ] ESM is enabled
- [ ] Vite serves a minimal client entry
- [ ] TS server entry can boot

Task breakdown:

- [ ] Add TypeScript/Vite/TSX/Vitest dependencies
- [ ] Add root TS config
- [ ] Add Vite config with client entrypoints
- [ ] Add server TS config/build config
- [ ] Add `dev`, `build`, `typecheck`, `test` scripts
- [ ] Create initial source tree and placeholder entries
- [ ] Decide output paths and align scripts to them

### WS1: Shared contracts and schemas

Status: blocking

Dependencies:

- WS0

Outputs:

- `src/shared/contracts/ws.ts`
- `src/shared/contracts/http.ts`
- `src/shared/contracts/config.ts`
- `src/shared/contracts/turn-script.ts`
- `src/shared/contracts/faces.ts`
- `src/shared/contracts/worker.ts`
- runtime validators or type guards

Acceptance criteria:

- [ ] WebSocket messages are defined as unions
- [ ] HTTP payloads used by `/health`, `/stats`, `/config`, `/voice`, `/tts`, face APIs, and PayPal APIs are typed
- [ ] turn-script payloads are typed
- [ ] worker messages are typed
- [ ] config/state enums are typed

Task breakdown:

- [ ] Extract config value enums from legacy `src/config.js`
- [ ] Define client/server WS message types
- [ ] Define HTTP request/response types
- [ ] Define face library and recognition payload types
- [ ] Define worker message types
- [ ] Add validators for untrusted inputs

### WS2: Server rewrite

Status: parallel after WS1

Dependencies:

- WS0
- WS1

Outputs:

- `src/server/index.ts`
- `src/server/routes/*`
- `src/server/ws/*`
- `src/server/config/*`
- `src/server/assistant/*`
- `src/server/processing/*`
- `src/server/integrations/*`
- `src/server/lib/*`

Acceptance criteria:

- [ ] Server boots from TS source
- [ ] No CommonJS remains in the active server path
- [ ] HTTP and WS responses use shared contracts
- [ ] Python/process boundaries are typed

Task breakdown:

- [ ] Replace `src/bridge-server.js` with `src/server/index.ts`
- [ ] Split legacy `src/routes.js` into route modules
- [ ] Split legacy `src/websocket.js` into typed WS modules
- [ ] Move config/runtime normalization into typed server config modules
- [ ] Move assistant orchestration into typed server modules
- [ ] Move processing mode management into typed modules
- [ ] Move PayPal and provider integrations into typed modules

### WS3: Client shell rewrite

Status: parallel after WS1

Dependencies:

- WS0
- WS1

Outputs:

- `src/client/main.ts`
- `src/client/mini-main.ts`
- `src/client/state/*`
- `src/client/transport/*`
- `src/client/ui/*`
- `src/client/runtime/*`

Acceptance criteria:

- [ ] Main app boots in Vite
- [ ] Mini window boots in Vite
- [ ] Client uses shared WS/HTTP contracts
- [ ] Base state and message handling are typed

Task breakdown:

- [ ] Move `public/js/main.js` logic into `src/client/main.ts`
- [ ] Move `public/js/mini-main.js` logic into `src/client/mini-main.ts`
- [ ] Move `public/js/state.js` into typed client state
- [ ] Move `public/js/websocket.js` into typed client transport
- [ ] Move `public/js/message-handler.js` into typed client message handling
- [ ] Move core DOM helpers into typed utilities

### WS4: Audio and interaction client modules

Status: parallel after WS3 shell exists

Dependencies:

- WS0
- WS1
- WS3

Outputs:

- typed client audio/input/TTS modules

Acceptance criteria:

- [ ] Push-to-talk works
- [ ] VAD/noise gate controls work
- [ ] TTS flow works against the current backend boundary
- [ ] subtitles/transcript state is typed

Task breakdown:

- [ ] Migrate `audio-input.js`
- [ ] Migrate `tts.js`
- [ ] Migrate `tts-text.js`
- [ ] Migrate `subtitles.js`
- [ ] Migrate `live-user-transcript.js`
- [ ] Migrate `ambient-audio.js`

### WS5: Face pipeline and worker

Status: parallel after WS1 and WS3

Dependencies:

- WS0
- WS1
- WS3

Outputs:

- `src/client/face/*`
- `src/workers/face-worker.ts`

Acceptance criteria:

- [ ] Camera pipeline boots from TS code
- [ ] Face worker is TypeScript
- [ ] Worker is loaded as a module worker
- [ ] face library and detection payloads use shared contracts

Task breakdown:

- [ ] Move `public/js/face/*` into `src/client/face/`
- [ ] Move `eye-tracking.js` and `vision-capture.js`
- [ ] Rewrite `public/js/face-worker.js` as `src/workers/face-worker.ts`
- [ ] Wire module worker loading through Vite
- [ ] Type ONNX and face-recognition result flows

### WS6: UI behavior and FX

Status: parallel after WS3

Dependencies:

- WS0
- WS1
- WS3

Outputs:

- typed client behavior/render/fx modules

Acceptance criteria:

- [ ] expressions, sleep/wake, proactive flow, panels, and glitch FX all boot from TS modules
- [ ] no remaining plain-JS UI runtime module is required for app startup

Task breakdown:

- [ ] Migrate `expressions.js`
- [ ] Migrate `emotion-engine.js`
- [ ] Migrate `idle-behavior.js`
- [ ] Migrate `sleep.js`
- [ ] Migrate `panel-ui.js`
- [ ] Migrate `fullscreen.js`
- [ ] Migrate `donation-ui.js`
- [ ] Migrate `proactive.js`
- [ ] Migrate `glitch-fx*`
- [ ] Migrate `face-renderer.js`

### WS7: Scripts and tooling

Status: parallel after WS0

Dependencies:

- WS0

Outputs:

- `src/scripts/*.ts`

Acceptance criteria:

- [ ] local TS scripts run through the new toolchain

Task breakdown:

- [ ] Migrate `scripts/benchmark-llm.js`
- [ ] Decide whether `docs/Glitch Tool/*` is migrated or archived
- [ ] If kept, migrate doc/demo JS to TS

### WS8: Python boundary evaluation

Status: parallel research track

Dependencies:

- WS1
- WS2

Outputs:

- decision note on whether Python stays or is replaced
- typed boundary contracts regardless of outcome

Acceptance criteria:

- [ ] STT/TTS/realtime Python paths have typed TS-side interfaces
- [ ] benchmark-based recommendation exists
- [ ] no forced rewrite happens without evidence

Task breakdown:

- [ ] Document current Python endpoints and payloads
- [ ] Benchmark current path where useful
- [ ] Evaluate realistic TS alternatives only if needed
- [ ] Record keep-vs-replace recommendation

### WS9: Cutover and deletion

Status: final blocking track

Dependencies:

- WS2
- WS3
- WS4
- WS5
- WS6
- WS7

Outputs:

- new runtime scripts
- legacy JS removed from active path

Acceptance criteria:

- [ ] `npm run dev` starts the new stack
- [ ] `npm run build` succeeds
- [ ] `npm run typecheck` succeeds
- [ ] legacy `public/js` app source is removed or dead
- [ ] legacy JS server entrypoints are removed or dead

Task breakdown:

- [ ] Switch startup scripts to new entries
- [ ] Remove old server JS entrypoints
- [ ] Remove old client JS entrypoints
- [ ] Remove dead compatibility code
- [ ] Update README for the new workflow

## Agent Allocation

This is the recommended parallel split.

### Agent 1

- WS0 Platform scaffold

### Agent 2

- WS1 Shared contracts

### Agent 3

- WS2 Server rewrite

### Agent 4

- WS3 Client shell rewrite

### Agent 5

- WS5 Face pipeline and worker

### Agent 6

- WS6 UI behavior and FX

### Agent 7

- WS7 Scripts/tooling

### Agent 8

- WS8 Python boundary evaluation

WS4 should start after the client shell has landed enough structure to plug into.

## Merge Sequence

Use this order to minimize conflicts.

1. Merge WS0
2. Merge WS1
3. Merge WS2 and WS3
4. Merge WS4, WS5, WS6, WS7 in parallel as ready
5. Merge WS8 decision note
6. Merge WS9 cutover and deletions

## Open Questions and Answers

These were open before. They are now resolved.

### Should we keep Python?

Answer: yes for now. Keep it behind typed interfaces. Replacing it is a separate performance-backed decision, not part of the mandatory TS migration.

### Should we preserve the current direct-from-`public/js` browser layout?

Answer: no. Move app source into `src/client/` and let Vite own the browser build.

### Should the backend stay CommonJS?

Answer: no. Move the active Node path to ESM TypeScript.

### Should workers stay classic workers?

Answer: no. Move them to TypeScript module workers under Vite.

### Should docs/demo code block the migration?

Answer: no. Defer or archive it.

### Should CSS reorganization be part of the critical path?

Answer: no. Keep CSS changes minimal unless they directly unblock the client move.

## First Tasks To Execute

If this starts immediately, do these first:

1. WS0 Task 1 through Task 6
2. WS1 config/contracts extraction
3. WS3 client shell skeleton
4. WS2 server skeleton

That gets the repo into a state where multiple agents can migrate modules without stepping on each other.

# Face service: face recognition on the server, headless

Status: built (2026-11-09, branch `feat/face-service`), checked against the
browser worker in headless Chrome and live on a test instance (below). The
observation shape is the contract both producers follow; it is in
`src/shared/contracts/studio.ts` (`FaceObservation`) and checked by
`isFaceObservation` (`src/shared/guards/index.ts`).

## Why

In studio mode the faces are recognised inside a Chrome page the server
launches (`studio-face.html?actor=main`, the listener), by the browser worker
(`src/workers/face-worker.ts`: SCRFD det_10g and ArcFace w600k_r50 on
onnxruntime-web). That is fragile:

- the models (~190 MB from huggingface) download into the page's temp Chrome
  profile, again for every new profile;
- when it breaks it is hard to see: the worker never becomes ready, and the
  dashboard shows "LOADING WORKER" with no inference time;
- it cannot run headless.

So recognition moves to a service on the server. The browser pages then only
draw faces and publish streams.

## Where it runs

Its own small Python service, `src/face-service.py`, supervised by the Tubs
server like Ming (`processing/process-service.ts`: own process group, restarted
with backoff, stopped with the server). Not inside the speech service:

- the speech service restarts when the speech-to-text model changes, and a
  crash in MLX (Whisper, Kokoro) would take recognition down with it;
- a camera loop running five times a second competes for the GIL with the
  audio streams the speech service serves;
- it must be able to run alone on another box (`fleet:faces`) without
  dragging Whisper and Kokoro along.

It runs from the existing `venv`: it needs only `numpy`, `onnxruntime` and
`Pillow` (`requirements-faces.txt`), all already there (onnxruntime comes with
faster-whisper). `ffmpeg` reads the camera.

| Setting | Values | Default |
|---|---|---|
| `FACE_SERVICE` | `off` · `local` (this machine, supervised) · `http(s)://host:port` (one already running elsewhere) · `fleet:faces` (the box the studio-manager hub at `FLEET_HUB` ranks first for `kind=faces`) | `off` |
| `FACE_SERVICE_PORT` | port of the local service | `3004` |
| `FACE_SERVICE_FPS` | frames checked per second | `5` |
| `FACE_MODEL_DIR` | where the models are kept, downloaded once | `~/.cache/tubs-face/models` |
| `FACE_SERVICE_BACKEND` | `auto` (CoreML on Apple Silicon, CUDA when onnxruntime has it, else CPU) · `coreml` · `cuda` · `cpu` | `auto` |
| `FACE_SERVICE_RTSP_PORT` | the site node's RTSP port | `8554` |

`FACE_SERVICE=off` keeps everything as it was (the browser worker).

## Who recognises

The service recognises when `FACE_SERVICE` is not `off`, studio mode is on and
the vision source is one the server can read:

| `visionSource` | Read by |
|---|---|
| `site:<path>` | the service, over RTSP: `rtsp://<site host>:8554/<path>` (the site node's read login, if it needs one, goes into the URL the service opens, never into a log) |
| `snapshot:<url>` | the service, one JPEG per frame from the URL |
| `local`, `local:<label>` | **the browser, for now.** This Mac's camera stays with the listener page and its browser worker. Opening it server-side (AVFoundation through ffmpeg) needs a camera permission that a background process started by studio-manager cannot get without someone at the screen, and it would fight the listener page for the device. The studio's cameras are site streams; a local camera is for the desk. |
| `off` | nobody |

The server tells the pages who recognises in `studio_config.faces`
(`'service'` or `'browser'`; absent means `'browser'`). With `'service'` the
listener page starts no face worker and loads no models; it takes the server's
`face_observation` messages into its state instead, so its sleep and proactive
lines still follow who is in view.

## Names settle per track (2026-11-09)

Live, one frame put Rapha 0.715 just ahead of Flo 0.678; the margin was 0.01,
so it named Flo "Rapha", Tubs greeted him so and the visit's notes went to
Rapha. Now, for both producers (`client/face/settle.ts`, used by the listener
page's runtime and by `server/faces/recognition.ts`):

- a frame accepts a name only 0.12 ahead of the next person
  (`MATCH_MARGIN`, `client/face/matching.ts`), calibrated on the library;
- a track is named only once 2 of its last 3 fresh embeddings accepted that
  person, or one accepted them very clearly (at least 0.75, and 0.3 ahead);
- a reused embedding is not a new vote (the service re-embeds a track every
  second; the worker reuses a tracked face's embedding for up to 8 checks);
- the name sticks to the track: frames that name nobody keep it, and another
  person needs as many votes to rename it;
- everything downstream (who is in view, greetings, relationships, field
  notes, the observation's `decision`) sees settled names only; a library
  change drops what was settled against the old one;
- the service path holds an arrival's greeting up to 2.5 s for a name on its
  way, so a known face is still greeted by name.

`src/scripts/face-library-audit.ts` audits the library (spread per person,
closest people, samples of different people alike enough to name each other);
`src/scripts/face-name-replay.ts` replays checks through the old and the new
naming (the studio's three live checks, the library leave-one-session-out, and
clips recorded with `tests/face-compat/record_lines.py`).

## The studio's switches

The service follows the Studio tab's switches (`GET/POST /studio switches`)
like the listener page's worker does:

- `camera` off: the service reads nothing (its source is `null`).
- `faceRecognition` and `visionDescriptions` both off: nothing to detect faces
  for, so the service reads nothing either.
- `faceRecognition` off, descriptions on: faces are still detected (presence,
  greetings, a picture when one appears), never matched against the library,
  no auto onboarding, and onboarding calls answer "face recognition is
  switched off".
- `visionDescriptions` off: no picture leaves the server; recognition goes on.
- While the service recognises, its own status stands in for the listener
  page's face worker wherever the server reports one (the camera and
  recognition parts, `/studio/vision` `faces`, the `faceWorker` of the
  `studio_live` relay).

## Frame rate budget

Five frames a second (`FACE_SERVICE_FPS`), each the newest one: a frame that
arrives while one is being checked is dropped, never queued. ffmpeg scales the
stream to at most 960 px wide (what the browser worker got) before the service
sees it.

Measured on the studio Mac (M3 Max, while the live Tubs and other work kept
the load average at ~14):

| Model | CoreML | CPU (4 threads) |
|---|---|---|
| SCRFD det_10g, 640×640 | 36 ms | 325 ms |
| ArcFace w600k_r50, per face | 4 ms | 66 ms |

With CoreML a frame with three faces costs ~50 ms, so 5 fps uses about a
quarter of one core's time. A track keeps its embedding for up to a second
(five frames) before it is computed again, like the browser worker reusing a
tracked face's embedding; new faces are embedded at once. On a CPU-only box
the service runs as fast as it can and reports the rate it reaches (`fps`).

## How results reach the Tubs server

```
camera (RTSP / snapshot URL)
  └─ ffmpeg ─ raw frames ─> face-service.py: detect, align, embed, track
                               │  GET /observations (NDJSON, one line per frame:
                               │  tracks, boxes, landmarks, embeddings, timings)
                               ▼
                      Tubs server (src/server/faces/)
                        match against the face library (client/face/matching.ts,
                        the browser's code: same thresholds, same decisions)
                        people tracker, visitor tracker, auto onboarding
                        (client/face/*.ts, the same modules the listener page runs)
                               │
     ┌────────────┬────────────┼──────────────┬───────────────┬──────────────┐
  people,      relationships  field notes   pulse `seen`,   studio_live   vision pictures
  presence,    (noteRecognised) (setPeople)  GET /studio/faces relay,       (appearance on a
  proactive                                  face_observation  /studio/vision new face, refresh
                                                                            every visionRefreshMs)
```

- The service's HTTP API (loopback for `local`):
  `GET /health` (state, backend, model download progress, error, fps, ms),
  `POST /source {url, fps}` (what to read; `null` stops), `GET /observations`
  (the stream), `GET /frame.jpg?max=` (the newest frame, for vision pictures),
  `GET /thumbnail?track=` (a face's crop, for auto onboarding),
  `POST /capture` (the next frame's faces with thumbnails, for onboarding),
  `POST /detect` (faces with embeddings in one posted picture; tests).
- The library is matched on the Tubs server, not in the service: one copy of
  the thresholds (`MATCH_THRESHOLD` 0.65, margin 0.01, top 3 per name), and the
  people's embeddings never leave this machine even when the service runs on
  another box. The embeddings of faces in view do travel from the service to
  the server: the people and visitor trackers and auto onboarding need them.
- The server feeds the same entry points the listener page's messages feed
  (`people`, `presence`, `proactive`, `appearance_frame`, `camera_frame`), with
  the same rules (who greets, when a visitor is gone, a call back). Vision
  pictures come from the service's newest frame, behind the same switches as
  before (vision provider, refresh period, hourly cap, asleep rule).
- Onboarding from the dashboard (`studio_face_call` begin, capture, save, end)
  is answered by the server with the service's camera; the answers are the
  ones the listener page gives. Saving writes the library and broadcasts
  `faces_changed`, as before.
- `GET /studio` `parts` gets a `recognition` part: where the work runs (the
  service's host, or the listener page), ok, and a detail such as
  `SCRFD+ArcFace · CoreML · 40 ms · 5 fps · 10 people`.

## The observation (both producers)

One frame's faces, from the face service or from the listener page's browser
worker. Same shape from both, so the dashboards and the debug view need not
know which ran.

```ts
interface FaceObservation {
  t: number;                    // when the frame was taken, ms since epoch
  source: string;               // the vision source, as visionSource: "site:cam-1"
  frame: { w: number; h: number };   // the picture as the detector saw it, px
  faces: Array<{
    track: number;              // same while the face stays in view (per producer)
    box: [x, y, w, h];          // 0..1 of the frame, as the camera sees it (not mirrored)
    score: number;              // detection score 0..1
    candidates: Array<{ name: string; sim: number }>;  // best sample per name, best first, ≤ 3
    decision: 'match' | 'unknown' | 'onboarding';
    name?: string;              // with 'match'
  }>;
  worker: {
    kind: 'service' | 'browser';
    state: 'off' | 'loading' | 'ready' | 'error';
    backend: string;            // "CoreML" | "CPU" | "CUDA" (service), "wasm" (browser)
    threads?: number;
    inferMs: number;            // detection + embeddings for this frame
    fps: number;                // frames checked per second, last few seconds
    error?: string;             // why not working; never a secret
    where: string;              // host or host:port doing the work
  };
}
```

- `faces` are the faces in view now, as the listener page counts them: a face
  missed for up to two frames (and 1.4 s) stays (`stabilizeFaces`).
- `decision`: `match` when the best candidate is at or over 0.65 and at least
  0.01 clear of the second (`annotateDetectedFaces`, `client/face/matching.ts`);
  `onboarding` when the face is not recognised and is being onboarded now (an
  onboarding dialog is open, or auto onboarding holds snapshots of that person);
  `unknown` otherwise.
- No embeddings and no landmarks in it: it goes to dashboards.
- Messages:
  - server → listener page and watching dashboards: `{type: 'face_observation', observation}`
    (a studio message: `isWsStudioServerMessage`);
  - listener page → server, when the browser worker produces it:
    `{type: 'face_observation', observation}` (studio listener page only; the
    server passes it on to watching dashboards and keeps the last one);
  - `GET /studio/faces` (local network): the last observation, or 404 before
    the first; the pulse's `seen` and `faceWorker` read the same one.

## Same embeddings as the browser

The library's embeddings came from the browser worker, so the service copies
the worker step by step (`src/face_pipeline.py`), not insightface's own Python
code, which differs in three places the library depends on:

| Browser worker (copied) | insightface | Cosine to the browser if the service did it insightface's way |
|---|---|---|
| anchor centres at `(col + 0.5) * stride` | `col * stride` | 0.53 to 0.94 (mean 0.73): landmarks move by half a stride, up to 16 px at stride 32 |
| B, G, R planes into ArcFace | R, G, B | 0.73 to 0.93 (mean 0.84) |
| B, G, R planes into SCRFD | R, G, B | 0.990 to 0.9998 (mean 0.997) |
| picture centred on black in 640×640 | padded at the bottom right | not measured separately |

All three together: 0.48 to 0.89 (mean 0.65), on the CPU backend. Resampling follows Chrome's canvas (bilinear,
pixel centres at +0.5, no mipmaps, rounded to 8 bits, black outside), and the
alignment uses the worker's own Umeyama with its closed-form 2×2 SVD.

`tests/face-compat/run.ts` runs the real worker (through its client, in
headless system Chrome 157, the models redirected to the service's cache) and
the service on the same pixels: five public domain photographs, seven faces.

| Service backend | Cosine to the browser, per face | Decisions that agree |
|---|---|---|
| CPU | 0.99998 to 0.99999 | 7/7 |
| CoreML, ML program on the GPU (FP32), the default | 0.99998 to 0.99999 | 7/7 |
| CoreML's default (neural network, Neural Engine, FP16), not used | 0.9954 to 0.9998 | 7/7 |

Detection scores agree to 0.0001 and landmarks to 0.012 px.
`tests/python/test_face_pipeline.py` holds the service to the browser's
embeddings (`tests/fixtures/faces/browser-embeddings.json`, cosine > 0.999).

The harness also showed a property of the worker itself: it reuses a tracked
face's embedding for any face overlapping one of the last frame's (up to 8
frames), so a different person stepping into the same spot within a few
seconds keeps the previous person's embedding for a while. The service tracks
the same way but recomputes a track's embedding every second.

## Live check (2026-11-09)

A test instance on free ports (`TUBS_STUDIO_LAUNCH=external`, its own face
service on :3464, a stub vision server, a temporary library through
`TUBS_FACE_LIBRARY`), reading a looping clip published to `cam-facetest` on the
local site node:

- onboarding through the service (`studio_face_call` begin, three captures,
  save, end) wrote three samples and broadcast `faces_changed`;
- `GET /studio/pulse` then named the enrolled face, `prob` 0.99, and left the
  three other faces unnamed (0.01 to 0.05);
- `recognition` part: `Mac:3464 · SCRFD+ArcFace · CoreML · 59 ms · 5 fps · 1 person`
  (the machine under load from other work);
- vision got an appearance picture when the faces came into view and refreshes
  every 30 s while they stayed, from the service's frames.

Through H.264 video at 960×540, another photo of the same man scored 0.62
against samples taken from video of the first photo, under the 0.65
threshold (0.69 between the two stills): onboarding a few poses in the room's
own light matters as much as before.

## Not done (yet)

- A local camera (`local`, `local:<label>`) stays with the listener page and
  its browser worker (see "Who recognises").
- The listener page still constructs its face worker object at startup
  (`createFaceShellRuntime`); with the service on it never initialises it, so
  no model is fetched or loaded and no frame is sent to it.
- With the service on another box, `TUBS_STUDIO_SITE` must be an address that
  box can reach (`127.0.0.1` would be its own loopback).
- `fleet:faces` asks the studio-manager hub for `kind=faces` providers; the hub
  has to list the face service boxes under that kind.
- The worker's anchor offset (above) misplaces the alignment; fixing it in
  both pipelines would mean onboarding everyone again.

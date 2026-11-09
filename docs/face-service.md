# Face service: face recognition on the server, headless

Status: design (2026-11-09, branch `feat/face-service`). The observation shape
below is the contract both producers follow; it is in
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
  - `GET /studio/faces` (local network): the last observation, or `null`.

# Vision: where Tubs' eyes come from and who looks at the pictures

Status: built (2026-11-08, branch `feat/studio-mode`), tested against a stub
OpenAI-compatible server, Gemini and a local Ollama (2026-11-09, below).
Applies to tubs-face in general; the studio mode only adds the `visionSource`
choice (default `off`: a `snapshot:` source needs its URL).

## Why

Vision is one of the main running costs. Today every picture goes to Gemini:

- `appearance_frame`: once when a new face appears (`src/client/face/runtime.ts:120`);
- `camera_frame`: every 30 s while a face is in view (`VISION_REFRESH_MS`, `runtime.ts:39,131`);
- both are handled by `src/server/assistant/vision.ts`, which always calls
  `generateGeminiContent` with the chat model (`runtimeConfig.llmModel`), even
  when `LLM_PROVIDER=ollama`.

One camera is about 120 calls an hour while someone is around. A venue with
several cameras multiplies that, for a job (describe clothing, hair, what
people hold) that current small open models do well on our own GPUs.

## What changes

### 1. A vision provider, separate from the chat LLM

| Setting | Values | Default |
|---|---|---|
| `VISION_PROVIDER` | `off` · `gemini` · `openai` | `gemini` (today's behaviour) |
| `VISION_MODEL` | model name for the provider | `gemini`: the chat model; `openai`: required |
| `VISION_BASE_URL` | `openai` only: an OpenAI-compatible base URL, or `fleet:vision` (picked by load, see below) | — |
| `VISION_API_KEY` | `openai` only, optional (local servers ignore it) | — |
| `VISION_MAX_PX` | longest side of the picture sent, in px | `512` |
| `VISION_TIMEOUT_MS` | give up and keep the last description | `8000` |

- `openai` speaks `POST {base}/chat/completions` with the picture as an
  `image_url` content part holding a `data:image/jpeg;base64,…` URL. One client
  covers Ollama (`http://<host>:11434/v1`), llama.cpp `llama-server`, vLLM, LM
  Studio and mlx-vlm, so the vision box can change without code changes.
- `off` never sends a picture anywhere: no description, no cost. Face
  detection, visitor tracking and enrollment keep working, because they run
  locally in the browser and never needed the provider.
- All of these are also live in `POST /config` (`visionProvider`,
  `visionModel`, `visionBaseUrl`, `visionMaxPx`), so the operator or the
  studio panel can switch to local or off mid-show.
- The prompt and the 60-word, no-judgement rules in `vision.ts` stay the same
  for every provider.

### 2. A budget, whatever the provider

| Setting | Meaning | Default |
|---|---|---|
| `VISION_REFRESH_MS` | periodic refresh while a face is in view (was a client constant) | `30000` |
| `VISION_MAX_PER_HOUR` | hard cap on calls per hour, per tubs-face instance | `120` |
| `VISION_WHILE_ASLEEP` | send pictures while Tubs sleeps | `false` |

- A new visitor still gets one immediate look (`appearance_frame`).
- Refreshes are skipped while Tubs sleeps, while nobody has been in view for
  the refresh period, and once the hourly cap is reached. The cap and the
  skips are logged once, not per frame.
- Calls, failures, latency and estimated cost per provider go into `/stats`
  next to the LLM's, so the cost of vision is visible on its own.

### 3. Where the pictures come from (studio mode)

`POST /studio` gains `visionSource`, with the same grammar as `micSource`:

```
local                  the camera of the page that owns vision (today's behaviour)
local:<device label>   that camera, by exact label
snapshot:<url>         fetch a JPEG from this URL when a picture is needed (no stream)
site:<path>            the video of a site node stream, opened over WHEP only while pictures are taken
off                    no pictures
```

- `snapshot:` is the default for studio cameras: depthcam-studio already
  serves `GET /api/snapshot/color.jpg`, the latest colour frame, so a picture
  costs one HTTP request and nothing streams in between.
- `site:` opens WHEP for a short burst (one appearance picture, or one
  refresh), then closes; the site node's on-demand mirrors cost nothing while
  nobody reads them.
- Face detection and visitor tracking run on the same pictures, at their own
  low rate (they are local and cheap), so presence and enrollment work with a
  studio camera as they do with the page's own.
- The director chooses the source (see sentient-studio
  `docs/perception.md`); tubs-face only follows what `POST /studio` says.

## Local models to try first

Candidates as of November 2026. Use the **`-instruct`** tags: the plain
`qwen3-vl:4b` is the thinking variant, which spends all its tokens thinking
(even with `think: false`) and returns empty content; tubs-face then logs
"answered with no text … use an -instruct one" and keeps the last description.

| Model (Ollama tag) | Size | Why |
|---|---|---|
| `qwen3-vl:4b-instruct` | ≈ 3.3 GB | strong on detail and text for its size; fits small cards. Measured below |
| `qwen3-vl:8b-instruct` | ≈ 6.2 GB | better quality if the box has room; not measured yet |
| `gemma4:e4b` | fits 8 GB | general image use, easy setup |
| MiniCPM-V, Moondream 2 | smaller | only if the box is very constrained |

Measured on this Mac (Ollama 0.30.8 at `127.0.0.1:11434`, through its
OpenAI-compatible `/v1/chat/completions`, the studio's two face pages and Ming
running), with a public test photo of one person with an umbrella (272 × 512):

- `qwen3-vl:4b-instruct`, a new picture each time (what a camera sends):
  2.6–2.8 s end to end inside tubs-face (frame received to description
  stored; tubs-face itself adds a few ms), 3.1–3.6 s calling Ollama directly.
- The same picture again: 0.75–0.95 s, because Ollama reuses the cached
  prompt with the image. Do not take this as the camera case.
- First call after loading: 14.6 s. About 45–60 output tokens.
- Descriptions: olive puffer jacket, plaid shirt, scarf, glasses, red
  umbrella, smiling, wet street with crosswalk. With the old prompt it labelled
  a single person "Left:" (and sometimes "Right: no other people"); the
  prompt now asks for labels only with two or more people (checked: one person
  5 of 5 without a label, two people 5 of 5 with Left:/Right:, Gemini the same).
  It still writes "a man"/"he" at times despite the no-gender rule.
- For comparison, Gemini (`gemini-3.5-flash`) took 1.7–1.8 s per picture.

### Where it runs: any box, picked by load

The vision model is plug and play: linux-monster, the 5090 laptop, the
Windows tower or the Mac, whichever has room. It runs as an ordinary
studio-manager service row (an Ollama or llama-server with the model) that
declares `provides: "vision"`, so studio-manager starts, stops and health
checks it like FluxRT.

`VISION_BASE_URL` accepts `fleet:vision` besides a plain URL. tubs-face then
asks the hub, `GET /api/fleet/providers?kind=vision&healthy=1`
(studio-manager `docs/providers-contract.md`). It takes the first answer:
ready and idle first, then by GPU load. It uses that box's `lanBases` entry
when one answers, else `serverBase`, plus `/v1`. It resolves again when a call
fails or times out, and every 5 minutes, so a busy or stopped box is left
behind without a restart. With the hub unreachable it keeps the last
resolved URL. A plain URL still works for a fixed box or a setup without
studio-manager.

Acceptance for a model: the description of a two-person test picture in
under 1.5 s on the chosen box, no judgement words, left/middle/right order
kept, and an operator reading ten descriptions side by side with Gemini's
finds them good enough for Tubs' remarks.

## Tests that have to exist

- `VISION_PROVIDER=off`: no network call for any frame, and enrollment and
  visitor tracking still work.
- `openai`: the request carries the image as an `image_url` data URL, scaled
  to `VISION_MAX_PX`, to `{base}/chat/completions`; a timeout keeps the last
  description and does not block a turn.
- Switching the provider through `POST /config` takes effect on the next
  picture, without a restart.
- The hourly cap holds; no refresh while asleep; a new visitor is still
  looked at once.
- `visionSource=snapshot:` fetches exactly one JPEG per picture;
  `site:` closes its WHEP session after the burst.
- `fleet:vision` picks the provider the hub ranks first, moves to the next
  one when a call fails, and keeps the last good URL while the hub is down.

## Sources for the model picks

- https://tinyweights.dev/posts/best-local-vision-language-models-2026/
- https://www.promptquorum.com/power-local-llm/local-vision-models-llava-ollama-2026
- https://docs.ollama.com/capabilities/vision
- https://docs.ollama.com/api/openai-compatibility
- https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md

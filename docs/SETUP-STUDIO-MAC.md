# Set up Tubs on a studio Mac

For a person, or the coding agent helping them, setting up Tubs (tubs-face in studio mode) on a Mac
for the RnA studio. About 20 minutes, most of it downloads. Check each step before the next.

## 1. What the Mac needs

- **Apple Silicon** (M1 or newer). The cloned voices (Ming) run on MLX, Apple Silicon only.
- **Node 24** or newer: `node --version`.
- **Python 3.11** for the voices: `python3.11 --version`, else `brew install python@3.11`.
- **Google Chrome** (the two face pages run in it).
- About 6 GB free for the speech and voice models.

## 2. Get the code and install

```sh
git clone https://github.com/laubsauger/tubs-face.git && cd tubs-face
npm ci
```

Studio mode is on `main`. A checkout from before 10 Nov 2026 may still be on `feat/studio-mode`:
`git switch main && git pull`, then `npm ci` again.

`npm ci` does the whole setup:
- the speech service's Python environment (`venv/`);
- the voices (`venv-ming/`, plus the Ming model download, about 2 GB);
- a `.env` copied from `.env.example`.

Read the end of its output: an `ERROR` from `[setup-ming]` means the voices are not set up, and Tubs
will not speak until it's fixed (`npm run setup-ming` after fixing what it says). There is no silent
fallback to other voices.

The voice references (Tubs and Mini) are in the repo, in `assets/ming-voices/`.

## 3. The Gemini key

Tubs thinks with Google Gemini, and the key is the one secret it needs.

1. The person gets a key at https://aistudio.google.com/apikey (a Google account; "Create API key").
2. **The person pastes it into `.env` themselves:** the line `GEMINI_API_KEY=` near the top.
   An agent should not ask for the key in chat, print it, or put it anywhere else.
3. Check without showing it: `grep -c '^GEMINI_API_KEY=..' .env` prints `1`.

`.env` is in `.gitignore`; never commit it. The voice and two-head settings in it are already right:
`REALTIME_KOKORO_VOICE=ming:friend`, `SECONDARY_VOICE=ming:friend-b`, `DUAL_HEAD_ENABLED=true`,
`DUAL_HEAD_MODE=llm_directed`.

## 4. Optional private files

- `data/face-library.json`: the people Tubs recognises (biometric). Without it Tubs knows nobody
  and learns people as they onboard. Copy it from the current show Mac only if the person wants
  that, over a private route (AirDrop), never git.
- `data/site-login.json`: only when publishing to the studio's site node directly (`{"user": "tubs", "pass": "…"}`, `chmod 600`).

## 5. Start Tubs in studio mode

```sh
PORT=3100 TUBS_STUDIO=1 TUBS_STUDIO_SITE=http://127.0.0.1:8889 \
TUBS_STATE_FILE=data/tubs-state.json TUBS_TONIGHT_FILE=data/tonight.json FACE_SERVICE=local \
TUBS_MIC_SOURCE=local TUBS_VISION_SOURCE=local \
npx tsx src/server/index.ts
```

- A site node (mediamtx) must run on this Mac first (`TUBS_STUDIO_SITE`): see sentient-studio
  `docs/LOCAL.md`, or point it at the studio's.
- **Ready:** `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/healthz` gives `200`
  (speech service, Ming and both face pages up). The first start takes longer while models load.
  A `503` names what isn't up yet in `curl -s http://127.0.0.1:3100/health`.
- **Look at it:** http://127.0.0.1:3100/?view=dashboard, Studio tab. "What runs where" shows the
  voices (Ming on :3003), the faces publishing, recognition and the mic.
- macOS asks once for the camera and microphone for the face pages: allow both.

## 6. Hook it to the show

The sentient-studio director talks to this Tubs: start it with `--tubs-face http://127.0.0.1:3100`
(or this Mac's address if the director runs elsewhere). See sentient-studio `docs/ONBOARDING.md`.

## When something's off

| You see | Do |
|---|---|
| `/healthz` 503, `ming` down | `npm run setup-ming` and read its output; check `python3.11` exists |
| No reply at all | `GEMINI_API_KEY` in `.env`, then restart |
| Voices sound wrong (not Tubs/Mini) | `.env` has a Kokoro voice set on purpose? Remove those two lines |
| Faces not publishing | the site node isn't running at `TUBS_STUDIO_SITE` |

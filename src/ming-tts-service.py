"""Ming-3.0 friend-voice TTS service for Tubs, with streaming.

The Tubs server starts it from its own venv (venv-ming, `npm run setup-ming`), because it needs a
newer mlx than speech-to-text. Moved here from ~/Movies/tubs-voice-lab/ming_service_stream.py, where
the listening tests behind every setting below live.

Start by hand:  venv-ming/bin/python -I src/ming-tts-service.py [--port 3003]
        (the port can also come from MING_PORT; --port wins)
Voice references are read from MING_VOICE_DIR (default data/ming-voices, kept out of git).
HTTP on 127.0.0.1:3003 (stdlib ThreadingHTTPServer):
  GET  /health      -> {"status", "model", "ready", "reference", "stream"}
  Both POSTs take an optional "voice" (a key of VOICES below, default "friend").
  POST /tts         {"text": "..."} -> audio/wav, 24 kHz mono 16-bit PCM, header X-Render-Ms
  POST /tts/stream  {"text": "..."} -> application/x-ndjson, one line per chunk as soon as it is ready:
                      {"audio": "<base64 WAV, 24 kHz mono 16-bit>", "index": n, "last": bool}
                    then {"done": true, "render_ms", "audio_s", "chunks", "first_chunk_ms", ...},
                    or {"error": "..."} if the render fails midway.
                    Joined, the chunks are what /tts renders from the same latents (see render_stream).

Setup = run-4 winner "Base A + clean-12s + endfix soften+fade":
  - mlx-community/Ming-3.0-tts-0.5B-bf16 via mlx-audio 0.6.4 (site-packages untouched; patches below
    are applied at runtime to this process only)
  - official settings: VAE posterior std = softplus(scale)+1e-4 (official sampler), reference latent
    encoded once (seed 1895), CAM++ speaker embedding of the reference, "Target language: English." prompt
  - reference ref_rec_full.wav + corrected transcript (ref_rec_full.txt): see VOICES
  - [..] tags stripped, whitespace collapsed, whole text in one generate() call (Ming itself still
    splits text over ~24 words into fragments, as the official code does)
  - runaway safety cap at 4x expected duration (logged), then end fix (soften separated final release,
    fade) and silence trim to ~40 ms lead / ~200 ms tail
One render at a time (lock; further requests queue), streamed or not. A streamed render stops when its
client disconnects. Never plays audio.
"""
import argparse
import base64
import io
import json
import math
import os
import re
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("HF_HUB_OFFLINE", "1")  # everything is already in the HF cache

import mlx.core as mx  # noqa: E402
import numpy as np  # noqa: E402
from scipy.signal import resample_poly  # noqa: E402

from ming_eq import VoiceEQ  # noqa: E402  (src/, next to this file)

# The references are recordings of a real person, and this repo is public: they stay out of git.
VOICE_DIR = os.environ.get("MING_VOICE_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "ming-voices")
HOST, PORT = "127.0.0.1", int(os.environ.get("MING_PORT", "3003"))
REPO = "mlx-community/Ming-3.0-tts-0.5B-bf16"
# Voices: name -> reference. Each has <ref>.wav, <ref>.txt (corrected transcript) and
# spk_emb_<ref>.npy in VOICE_DIR (CAM++, Chatterbox encoder = Ming's campplus weights). Requests pick one
# with "voice" (default "friend"); Tubs calls them ming:<name>.
# References (voice lab runs 14 and 15): cut in real pauses with short fades, since a reference that starts or
# ends inside a word teaches Ming clipped words ("bad idea-"); taken at 44.1 kHz (Ming's tokenizer rate) from the
# 48 kHz originals instead of the 24 kHz copies that ended at 12 kHz. Ming copies the room too: Mini's recording
# has AC rumble (-45 dB, under 100 Hz), so its references are high-passed at 80 Hz and gently denoised
# (ffmpeg afftdn, 10 dB, noise learned from a pause), which took the noise in Mini's lines from -43 to -59 dB.
# Main's room is quieter and its lines got noisier from a denoised reference, so main's is not denoised.
# Older references (ref_*_clean, ref_rec_12s, ref_B_12s, ref_B_10s) are kept in the folder for rollback.
VOICES = {
    "friend": "ref_rec_full",           # main Tubs: the friend's first character (clean studio recording), 0-11.72 s
    "friend-b": "ref_B_full_dn",        # Mini: the friend's second character, friend-B_short.wav 2.30-12.56 s
    "friend-b-alt": "ref_B_alt_full_dn", # Mini, other take: the same recording from 12.86 s to the end
}
DEFAULT_VOICE = "friend"
# Each voice's EQ curve in ming_eq.py (the user picked "round", voice lab run 16).
VOICE_EQ = {"friend": "main", "friend-b": "mini", "friend-b-alt": "mini"}
PROMPT = "Please generate speech based on the following description.\nTarget language: English.\n"
OUT_SR = 24000
LATENT_HZ = 12.5
SAFETY = 4.0
LEAD_S, TAIL_S, FADE_S = 0.04, 0.20, 0.04

STATE = {"ready": False, "error": None}
READY = threading.Event()
LOCK = threading.Lock()
M = {}
V = {}  # voice name -> wav, text, spk, ref_latent, spk_proj


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def clean_text(t):
    t = re.sub(r"\[[^\]]*\]", " ", str(t or ""))
    return re.sub(r"\s+", " ", t).strip()


def exp_s(text):  # same estimate as runs 2-4: 2.6 words per second, floor 1 s
    return max(1.0, len(re.findall(r"[A-Za-z0-9']+", text)) / 2.6)


# ---- end fix + silence trim (from run4/endfix.py "soften+fade", tail/lead per the service spec)
def voiced_segments(a, sr, ms=10):
    n = int(sr * ms / 1000)
    k = a.size // n
    if k == 0:
        return []
    db = 20 * np.log10(np.sqrt((a[: k * n].reshape(k, n) ** 2).mean(1)) + 1e-9)
    on = db > np.percentile(db, 90) - 30
    segs, s = [], None
    for i, v in enumerate(on):
        if v and s is None:
            s = i
        if not v and s is not None:
            segs.append([s, i])
            s = None
    if s is not None:
        segs.append([s, k])
    merged = []
    for sg in segs:
        if merged and sg[0] - merged[-1][1] < 3:
            merged[-1][1] = sg[1]
        else:
            merged.append(sg)
    return [(s * n, e * n) for s, e in merged]


def finish(a, sr):
    a = a.astype(np.float32).copy()
    segs = voiced_segments(a, sr)
    if not segs:
        return a, False
    softened = False
    if len(segs) >= 2:  # over-separated final consonant release -> -12 dB
        (_, pe), (ls, le) = segs[-2], segs[-1]
        if (le - ls) < 0.15 * sr and (ls - pe) >= 0.05 * sr and le > a.size - 0.6 * sr:
            g = np.full(le - ls, 0.25, np.float32)
            r = min(int(0.01 * sr), (le - ls) // 2)
            if r > 0:
                g[:r] = np.linspace(1, 0.25, r)
            a[ls:le] *= g
            softened = True
    start = max(0, segs[0][0] - int(LEAD_S * sr))
    end = min(a.size, segs[-1][1] + int(TAIL_S * sr))
    a = a[start:end]
    fi = min(int(0.005 * sr), a.size)
    a[:fi] *= np.linspace(0, 1, fi)
    fo = min(int(FADE_S * sr), a.size)
    a[a.size - fo:] *= np.linspace(1, 0, fo)
    return a, softened


def to_wav(a, sr):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(a, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def load():
    from mlx_audio.tts.models.bailingmm import bailingmm as bm
    from mlx_audio.tts.models.bailingmm.bailingmm import MING3_MAX_FRAGMENT_LENGTH, _add_period, _split_fragments
    from mlx_audio.tts.utils import load_model
    from mlx_audio.utils import load_audio

    t0 = time.perf_counter()
    model = load_model(REPO)

    def encode_latent(self, waveform, waveform_length):  # official Oobleck posterior: std = softplus(scale)+1e-4
        frame_num = mx.ceil(waveform_length / self.config["enc_kwargs"]["input_dim"]).astype(mx.int32)
        if self.patch_size != -1:
            frame_num = mx.ceil(frame_num / self.patch_size).astype(mx.int32)
        h = self.encoder(waveform).transpose(0, 2, 1)
        mu, scale = mx.split(h, 2, axis=1)
        std = mx.logaddexp(scale, mx.zeros_like(scale)) + 1e-4
        return (mu + std * mx.random.normal(mu.shape, dtype=mu.dtype)).transpose(0, 2, 1), frame_num

    bm.AudioVAE.encode_latent = encode_latent
    orig_encode, cache = model._encode_prompt_latent, {}

    def cached_encode(wave_):  # official code encodes the reference once
        key = (tuple(wave_.shape), float(mx.sum(wave_).item()))
        if key not in cache:
            mx.random.seed(1895)
            cache[key] = orig_encode(wave_)
            mx.eval(cache[key])
        return cache[key]

    model._encode_prompt_latent = cached_encode

    # Compiled per latent: the flow solve (10 steps, both CFG branches; ~75% of the GPU time) and the
    # aggregator. Same ops, so the audio is bit-identical; ~12% less time per latent (voice lab run 18).
    # The noise is drawn outside the compiled graph exactly as FlowLoss.sample draws it, so seeded renders
    # see the same random numbers. Relies on mlx-audio internals (pinned in requirements-ming.txt).
    compiled_flow = {}

    def flow_sample(self, z, latent_history, cfg=1.0, patch_size=1, sigma=0.25, temperature=0.0, steps=10):
        assert self.cfm.ming3_sampling
        noise = mx.random.normal((z.shape[0], patch_size, self.z_channels), dtype=z.dtype)
        sde_noise = mx.random.normal((steps, *noise.shape), dtype=z.dtype)
        key = (id(self), cfg, patch_size, sigma, temperature, steps)
        if key not in compiled_flow:
            cfm = self.cfm

            def solve(z_, hist_, noise_, sde_):
                out, _ = cfm.sample(noise=noise_, c=z_, latent_history=hist_, cfg_scale=cfg, patch_size=patch_size,
                                    sigma=sigma, temperature=temperature, steps=steps, sde_noise=sde_)
                return out
            compiled_flow[key] = mx.compile(solve)
        return compiled_flow[key](z, latent_history, noise, sde_noise), None

    bm.FlowLoss.sample = flow_sample
    aggregator = model.linear_proj_audio
    compiled_aggregator = mx.compile(lambda x: aggregator(x))

    class Aggregator:  # only the per-latent shape is compiled; the reference latent (147 frames) goes the plain way
        def __call__(self, x):
            return compiled_aggregator(x) if x.shape == (1, 1, 64) else aggregator(x)

    model.linear_proj_audio = Aggregator()
    M.update(model=model, frag=lambda t: _split_fragments(_add_period(t), MING3_MAX_FRAGMENT_LENGTH))
    for name, ref in VOICES.items():
        v = V[name] = dict(wav=os.path.join(VOICE_DIR, f"{ref}.wav"),
                           text=open(os.path.join(VOICE_DIR, f"{ref}.txt")).read().strip(),
                           spk=mx.array(np.load(os.path.join(VOICE_DIR, f"spk_emb_{ref}.npy"))))
        render("Not bad. Not bad at all.", name)  # warm-up (also fills the reference-latent cache)
        # What generate() derives from ref_audio/spk_emb on every call, for the streamed path. The reference
        # is loaded exactly as generate() loads it, so this hits the latent cache the warm-up filled.
        v.update(ref_latent=model._encode_prompt_latent(load_audio(v["wav"], sample_rate=model.sample_rate)),
                 spk_proj=model._speaker_embeddings(v["spk"], False))
        # Evaluated here: MLX can't evaluate a lazy array built in this (loader) thread from a request thread.
        mx.eval(v["ref_latent"], v["spk_proj"])
    render_stream("Not bad. Not bad at all.", lambda wav, last: None)  # warm-up of the incremental decoder
    STATE["ready"] = True
    READY.set()
    log(f"ready: model + reference loaded and warmed up in {time.perf_counter() - t0:.1f}s, "
        f"active GPU memory {mx.get_active_memory() / 1e9:.2f} GB")


# Each render starts from the same random state. Unseeded, the same line came out as a different take
# after every restart (voice lab run 17: 0 of 20 lines matched, some 0.4 s longer), so a clip approved by ear
# was not what played later. Seeded, all 20 matched across restarts, at no cost in speed.
RENDER_SEED = 0


def render(text, voice=DEFAULT_VOICE):
    model, v = M["model"], V[voice]
    mx.random.seed(RENDER_SEED)
    fexp = max(exp_s(f) for f in M["frag"](text))
    cap_s = SAFETY * exp_s(text)
    kw = dict(lang_code="en", stream=True, ref_audio=v["wav"], ref_text=v["text"], spk_emb=v["spk"],
              prompt=PROMPT, max_tokens=math.ceil(SAFETY * fexp * LATENT_HZ))
    chunks, got, sr, cut = [], 0, None, False
    gen = model.generate(text=text, **kw)
    for r in gen:
        a = np.array(r.audio, dtype=np.float32).reshape(-1)
        sr = r.sample_rate
        chunks.append(a)
        got += a.size
        if got / sr > cap_s:
            cut = True
            gen.close()
            break
    a = np.concatenate(chunks) if chunks else np.zeros(1, np.float32)
    if cut:
        a = a[: int(cap_s * sr)]
    a, softened = finish(a, sr)
    if sr != OUT_SR:
        g = math.gcd(OUT_SR, sr)
        a = resample_poly(a, OUT_SR // g, sr // g).astype(np.float32)
    return VoiceEQ(VOICE_EQ[voice])(a), cut, softened


# ---- streaming (POST /tts/stream)
#
# Why this can stream at all (checked in mlx_audio/tts/models/bailingmm/bailingmm.py and the model config):
#   - The audio VAE decoder is a Qwen2 stack with "is_causal": true and a 64-frame sliding window on every
#     layer (use_sliding_window, max_window_layers 0), so a frame's output depends only on earlier frames.
#     Feeding new frames through a KV cache gives the same output as decoding the whole fragment at once.
#   - Its ISTFT head (n_fft 3528, hop 882 at 44.1 kHz) is plain overlap-add; ISTFTHead already carries the
#     3 unfinished hops between calls (streaming=True), which mlx-audio uses for the older Ming models.
#   - The only lookahead is the 4x linear upsampler from 12.5 Hz latents to 50 Hz frames: the last two
#     frames of a latent need the next latent.
# mlx-audio's Ming-3.0 path just doesn't use any of this: it decodes each fragment (<= 24 words) in one pass
# after the last latent, so the first audio waits for the whole fragment.
#
# Post-processing is render()'s, split by position: the lead trim needs the voice onset, decided once from
# the audio so far (the first chunk); the end fix, tail trim and fade only touch the last HOLD_S, which is
# held back until the stop head fires. Resampling to 24 kHz runs per chunk with RS_CTX of real context on
# both sides and chunk edges on the 147:80 sample grid, so it equals resampling the whole clip.
# First chunk: this much audio from the trimmed start, as early as possible. 0.25 s instead of 0.40 s cut the
# first chunk from 283 to 204 ms (455 to 306 ms with a second Ming rendering nonstop), with the same audio
# (93 dB SNR, rounding) and no playback gaps in 20 lines either way (voice lab run 17).
FIRST_S = 0.25
NEXT_S = (0.5, 1.0, 1.5)  # later chunks grow to 1.5 s ...
LOW_WATER_S = 0.30      # ... but whatever is ready goes out when the listener has less than this queued
HOLD_S = 0.50           # held back near the end: the end fix, tail trim and fade land in the last chunk
SAFE_FRAC = 0.6         # a reply is assumed to run at least this share of exp_s(); before that, no hold
SPEECH_DB = -45.0       # no onset decision before the loudest 10 % of 10 ms frames reach this level
ONSET_MARGIN_DB = 2.0   # the opening can be ~1.5 dB louder than the whole clip: err towards keeping lead-in
DECODE_EVERY = ((2.0, 8), (0.0, 4))  # (listener has > s queued, latents per decode step); a step costs ~20 ms
RS_ALIGN = 147          # 44.1 kHz samples per 80 samples at 24 kHz
RS_CTX = 2 * RS_ALIGN   # resampler context per side (its FIR reaches ~19 input samples)


class FragmentDecoder:
    """Decodes one fragment's latents as they arrive, with the decoder's KV cache and ISTFT buffers."""

    def __init__(self, decoder):
        from mlx_audio.lm.models.cache import KVCache

        self.d = decoder  # model.audio.decoder
        self.lat = []
        self.fed = 0  # 50 Hz frames already through the transformer
        self.cache = [KVCache() for _ in decoder.decoder.layers]
        self.abuf = self.wbuf = None

    def decode(self, last=False):
        p = self.d.patch_size
        upto = len(self.lat) * p if last else len(self.lat) * p - p // 2  # frames that don't need lookahead
        if upto <= self.fed or (self.fed == 0 and upto < 2 and not last):  # ISTFT's first call needs 2 frames
            return np.zeros(0, np.float32)
        x = self.d._upsample(self.d.fc1(mx.concatenate(self.lat, axis=1)))[:, self.fed:upto]
        h = self.d.decoder(mx.zeros((1, x.shape[1]), dtype=mx.int32), cache=self.cache, input_embeddings=x)
        wav, _, self.abuf, self.wbuf = self.d.head(h, audio_buffer=self.abuf, window_buffer=self.wbuf,
                                                  streaming=True, last_chunk=last)
        self.fed = upto
        return np.array(wav[0], dtype=np.float32)


def kept_len(a, sr):
    """Samples of a fragment that mlx-audio's _trim_trailing_silence would keep if it ended here.
    Only grows as the fragment grows, so audio below it is final."""
    frame, tail = int(sr * 0.1), int(sr * 0.3)
    if a.size < frame:
        return a.size
    nf = a.size // frame
    loud = np.nonzero(np.abs(a[: nf * frame]).reshape(nf, frame).mean(axis=-1) > 1e-3)[0]
    return min(nf * frame, tail if loud.size == 0 else int(loud[-1]) * frame + frame + tail)


def onset_start(a, sr):
    """finish()'s lead-trim start, judged from the audio so far; None until there is clearly speech."""
    n = int(sr * 0.01)
    k = a.size // n
    if k < 10:
        return None
    db = 20 * np.log10(np.sqrt((a[: k * n].reshape(k, n) ** 2).mean(1)) + 1e-9)
    p90 = np.percentile(db, 90)
    if p90 < SPEECH_DB:
        return None
    return max(0, int(np.argmax(db > p90 - 30 - ONSET_MARGIN_DB)) * n - int(LEAD_S * sr))


class Emitter:
    """Cuts the raw 44.1 kHz audio into finished 24 kHz chunks; see the notes above FIRST_S."""

    def __init__(self, sr, send, eq):
        self.sr, self.send, self.eq = sr, send, eq
        self.up, self.down = OUT_SR // math.gcd(OUT_SR, sr), sr // math.gcd(OUT_SR, sr)
        assert self.down == RS_ALIGN, "chunk grid assumes 44.1 kHz -> 24 kHz"
        self.start = self.sent = None
        self.chunks = 0
        self.out_samples = 0
        self.t_first = None
        self.first_ms = None
        self.late = []  # post-processing that would have touched audio already sent (logged)
        self.gain = None  # (lo, hi, gains) applied by fin(), set at the end

    def fin(self, raw, i0, i1):
        """raw[i0:i1] with finish()'s gains applied (fade-in always, end gains once known)."""
        a = raw[i0:i1].copy()
        fi = int(0.005 * self.sr)
        lo, hi = max(i0, self.start), min(i1, self.start + fi)
        if hi > lo:
            a[lo - i0:hi - i0] *= np.linspace(0, 1, fi)[lo - self.start:hi - self.start]
        for g0, g in self.gain or ():
            lo, hi = max(i0, g0), min(i1, g0 + g.size)
            if hi > lo:
                a[lo - i0:hi - i0] *= g[lo - g0:hi - g0]
        return a

    def emit(self, raw, e, last=False):
        w0 = max(self.start, self.sent - RS_CTX)
        w1 = e if last else e + RS_CTX
        out = resample_poly(self.fin(raw, w0, w1), self.up, self.down).astype(np.float32)
        o0 = (self.sent - w0) * self.up // self.down
        out = self.eq(out[o0:] if last else out[o0:o0 + (e - self.sent) * self.up // self.down])
        if self.t_first is None:
            self.t_first = time.perf_counter()
        self.send(to_wav(out, OUT_SR), last)
        self.chunks += 1
        self.out_samples += out.size
        self.sent = e

    def offer(self, raw, avail, limit, flush=False):
        """New audio: raw[:avail] is final, raw[:limit] may go out now."""
        if self.start is None:
            start = onset_start(raw[:avail], self.sr)
            if start is None or limit - start < FIRST_S * self.sr:
                return
            self.start = self.sent = start
        e = self.start + (limit - self.start) // RS_ALIGN * RS_ALIGN
        if e <= self.sent:
            return
        target = FIRST_S if self.chunks == 0 else NEXT_S[min(self.chunks - 1, len(NEXT_S) - 1)]
        if (e - self.sent) >= target * self.sr or flush or (self.chunks and self.queued() < LOW_WATER_S):
            self.emit(raw, e)

    def queued(self):
        """Seconds of audio sent but not yet played, if playback started with the first chunk."""
        return self.out_samples / OUT_SR - (time.perf_counter() - self.t_first) if self.t_first else 0.0

    def decode_every(self):
        if not self.chunks:
            return 2
        q = self.queued()
        return next((n for above, n in DECODE_EVERY if q > above), DECODE_EVERY[-1][1])  # q <= 0: ran dry

    def close(self, raw):
        """raw is the final clip (fragments trimmed, cap applied): render()'s finish(), last chunk only."""
        sr = self.sr
        if self.start is None:  # nothing sent yet (short line): exactly what /tts would return
            a, softened = finish(raw if raw.size else np.zeros(1, np.float32), sr)
            a = self.eq(resample_poly(a, self.up, self.down).astype(np.float32))
            self.t_first = time.perf_counter()
            self.send(to_wav(a, OUT_SR), True)
            self.chunks, self.out_samples = 1, a.size
            return softened
        segs = voiced_segments(raw, sr)
        softened, gains = False, []
        if len(segs) >= 2:
            (_, pe), (ls, le) = segs[-2], segs[-1]
            if (le - ls) < 0.15 * sr and (ls - pe) >= 0.05 * sr and le > raw.size - 0.6 * sr:
                g = np.full(le - ls, 0.25, np.float32)
                r = min(int(0.01 * sr), (le - ls) // 2)
                if r > 0:
                    g[:r] = np.linspace(1, 0.25, r)
                gains.append((ls, g))
                softened = True
                if ls < self.sent:
                    self.late.append(f"release softening starts {(self.sent - ls) / sr * 1000:.0f}ms before the last chunk")
        end = min(raw.size, segs[-1][1] + int(TAIL_S * sr)) if segs else raw.size
        if end < self.sent:
            self.late.append(f"tail trim ends {(self.sent - end) / sr * 1000:.0f}ms into audio already sent")
            end = self.sent
        fo = min(int(FADE_S * sr), end - self.start)
        gains.append((end - fo, np.linspace(1, 0, fo).astype(np.float32)))
        if end - fo < self.sent:
            self.late.append("fade-out starts before the last chunk")
        self.gain = gains
        if end > self.sent:
            self.emit(raw, end, last=True)
        return softened


def render_stream(text, send, voice=DEFAULT_VOICE):
    """render(), handing out audio while it generates: send(wav_bytes, last) per chunk.

    Same fragments, sampler settings, cap and post-processing as render(); the only difference is
    when the latents are decoded (incrementally, see FragmentDecoder) and that the lead trim is
    decided from the first chunk's audio instead of the whole clip."""
    model, v = M["model"], V[voice]
    mx.random.seed(RENDER_SEED)
    sr = model.sample_rate
    frags = M["frag"](text)
    steps = math.ceil(SAFETY * max(exp_s(f) for f in frags) * LATENT_HZ)
    cap = int(SAFETY * exp_s(text) * sr)
    safe = int((SAFE_FRAC * exp_s(text) - HOLD_S) * sr)
    hold = int(HOLD_S * sr)
    em = Emitter(sr, send, VoiceEQ(VOICE_EQ[voice]))
    raw = np.zeros(sr * 8, np.float32)
    committed = 0  # raw[:committed] = finished fragments, trailing silence trimmed
    cut = False
    for fi, frag in enumerate(frags):
        last_frag = fi == len(frags) - 1
        dec = FragmentDecoder(model.audio.decoder)
        n = committed  # raw[committed:n] = this fragment so far, untrimmed

        def add(a):  # -> how much of raw is final (this fragment trimmed as if it ended now)
            nonlocal raw, n
            if n + a.size > raw.size:
                raw = np.concatenate([raw, np.zeros(max(a.size, raw.size), np.float32)])
            raw[n:n + a.size] = a
            n += a.size
            return committed + kept_len(raw[committed:n], sr)

        sampler = model.sample(prompt=PROMPT, text=frag, instruction=None, prompt_text=v["text"],
                               max_decode_steps=steps, cfg=2.0, sigma=0.25, temperature=0.0, flow_steps=10,
                               prompt_latent=v["ref_latent"], spk_emb=v["spk_proj"])
        kept = None
        decoded = 0  # latents in dec at its last decode step
        for latent, is_last in sampler:
            dec.lat.append(latent)
            if is_last or len(dec.lat) - decoded < em.decode_every():
                continue
            if em.chunks == 0 and fi == 0 and len(dec.lat) < 6:  # < 0.3 s decoded: no first chunk possible yet
                continue
            decoded = len(dec.lat)
            kept = add(dec.decode())
            if kept > cap:  # runaway: render() cuts here too (after the fragment, same samples)
                sampler.close()
                break
            limit = kept - RS_CTX
            if last_frag:
                limit = max(min(limit, safe), kept - hold)
            em.offer(raw, kept, min(limit, cap - hold))
            kept = None
        if kept is None:
            kept = add(dec.decode(last=True))
        cut = kept > cap
        committed = min(cap, kept)
        if cut:
            break
        if not last_frag:
            em.offer(raw, committed, min(committed - RS_CTX, cap - hold), flush=True)
    softened = em.close(raw[:committed])
    return {"chunks": em.chunks, "audio_s": em.out_samples / OUT_SR, "cut": cut, "softened": softened,
            "late": em.late, "first_s": (em.t_first - T0[0]) if em.t_first else None}


T0 = [0.0]  # perf_counter() at the start of the current streamed render, for first_chunk_ms


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quiet default access log; we log one line per /tts ourselves
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._json(200, {"status": "error" if STATE["error"] else "ok", "model": REPO,
                             "ready": STATE["ready"], "reference": f"{VOICES[DEFAULT_VOICE]}.wav", "stream": True,
                             "voices": {name: f"{ref}.wav" for name, ref in VOICES.items()},
                             **({"error": STATE["error"]} if STATE["error"] else {})})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path not in ("/tts", "/tts/stream"):
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "invalid JSON"})
        text = clean_text(data.get("text"))
        if not text:
            return self._json(400, {"error": "No text provided"})
        voice = data.get("voice") or DEFAULT_VOICE
        if voice not in VOICES:
            return self._json(400, {"error": f"unknown voice {voice!r}, have {sorted(VOICES)}"})
        if not READY.wait(timeout=600):
            return self._json(503, {"error": STATE["error"] or "model not ready"})
        if path == "/tts/stream":
            return self._stream(text, voice)
        try:
            with LOCK:  # one render at a time; other requests wait here
                t0 = time.perf_counter()
                audio, cut, softened = render(text, voice)
                ms = int((time.perf_counter() - t0) * 1000)
        except Exception as e:
            log(f"ERROR chars={len(text)} {type(e).__name__}: {e}")
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})
        body = to_wav(audio, OUT_SR)
        log(f"tts voice={voice} chars={len(text)} audio={audio.size / OUT_SR:.2f}s render={ms}ms cap_hit={cut}"
            f"{' release_softened' if softened else ''}")
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Render-Ms", str(ms))
        self.end_headers()
        self.wfile.write(body)

    def _stream(self, text, voice):
        self.close_connection = True  # the body ends when the connection does (no length, no chunked coding)

        def line(obj):
            self.wfile.write((json.dumps(obj) + "\n").encode())

        index = [0]

        def send(wav, last):
            line({"audio": base64.b64encode(wav).decode("ascii"), "index": index[0], "last": last})
            index[0] += 1

        with LOCK:  # one render at a time; other requests wait here
            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                T0[0] = t0 = time.perf_counter()
                st = render_stream(text, send, voice)
                ms = int((time.perf_counter() - t0) * 1000)
                first_ms = int(st["first_s"] * 1000) if st["first_s"] is not None else None
                line({"done": True, "render_ms": ms, "audio_s": round(st["audio_s"], 3), "chunks": st["chunks"],
                      "first_chunk_ms": first_ms, "cap_hit": st["cut"]})
            except (BrokenPipeError, ConnectionResetError) as e:
                log(f"tts_stream chars={len(text)} client went away after {index[0]} chunk(s) ({type(e).__name__}); "
                    f"render stopped")
                return
            except Exception as e:
                log(f"ERROR stream chars={len(text)} after {index[0]} chunk(s) {type(e).__name__}: {e}")
                try:
                    line({"error": f"{type(e).__name__}: {e}"})
                except OSError:
                    pass
                return
        log(f"tts_stream voice={voice} chars={len(text)} audio={st['audio_s']:.2f}s render={ms}ms first_chunk={first_ms}ms "
            f"chunks={st['chunks']} cap_hit={st['cut']}{' release_softened' if st['softened'] else ''}"
            + "".join(f" LATE({x})" for x in st["late"]))


def main():
    global PORT
    ap = argparse.ArgumentParser(description="Ming-3.0 friend-voice TTS service (with /tts/stream)")
    ap.add_argument("--port", type=int, default=PORT, help="default 3003, or MING_PORT")
    PORT = ap.parse_args().port
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True

    def loader():
        try:
            load()
        except Exception as e:
            STATE["error"] = f"{type(e).__name__}: {e}"
            log(f"ERROR loading: {STATE['error']}")

    threading.Thread(target=loader, daemon=True).start()
    log(f"listening on http://{HOST}:{PORT} (loading model in background)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    sys.exit(main())

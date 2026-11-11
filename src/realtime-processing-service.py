import base64
import io
import json
import os
import struct
import subprocess
import tempfile
import time
import uuid
import urllib.error
import urllib.request
import threading
import traceback

import numpy as np
from flask import Flask, Response, jsonify, request
from flask_sock import Sock

app = Flask(__name__)
sock = Sock(app)

import platform
_IS_MACOS = platform.system() == "Darwin"
_gpu_lock = threading.Lock()

PORT = int(os.environ.get("REALTIME_PROCESSING_PORT", "3002"))
STT_MODEL = os.environ.get("REALTIME_STT_MODEL", os.environ.get("WHISPER_MODEL", "small"))
STT_BACKEND = os.environ.get("REALTIME_STT_BACKEND", os.environ.get("STT_BACKEND", "mlx")).strip().lower()

# Auto-fallback: mlx STT is Apple Silicon only
if STT_BACKEND == "mlx" and not _IS_MACOS:
    print("[Realtime STT] WARNING: STT_BACKEND=mlx is Apple Silicon only - falling back to faster-whisper.")
    STT_BACKEND = "faster-whisper"

TTS_BACKEND = os.environ.get("REALTIME_TTS_BACKEND", os.environ.get("TTS_BACKEND", "kokoro")).strip().lower()
KOKORO_VOICE = os.environ.get("REALTIME_KOKORO_VOICE", os.environ.get("KOKORO_VOICE", "hm_omega"))
LLM_PROVIDER = os.environ.get("REALTIME_LLM_PROVIDER", "ollama").strip().lower()

# Kokoro backend: mlx_audio on macOS, KPipeline (ONNX) everywhere else
_KOKORO_BACKEND = "mlx" if _IS_MACOS else "native"
def get_ollama_base_url():
    url = os.environ.get("REALTIME_LLM_BASE_URL", "").strip()
    if url: return url.rstrip("/")
    host = os.environ.get("OLLAMA_HOST", "").strip()
    if host: return (host if host.startswith("http") else "http://" + host).rstrip("/")
    return "http://127.0.0.1:11434"

LLM_BASE_URL = get_ollama_base_url()
OPENAI_BASE_URL = os.environ.get("REALTIME_OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
MIN_STT_AUDIO_BYTES = int(os.environ.get("REALTIME_MIN_STT_AUDIO_BYTES", "2048"))
# Whisper writes fluent text for silence and noise ("you", "I'm sorry." x29).
# Its own guard skips a window only when no_speech_prob > 0.6 AND the text is
# low-confidence, so confident phantoms get through. Measured on this model
# (small): silence, noise and hum score 0.81-0.91, real speech 0.04-0.11.
# Anything at or above Whisper's 0.6 is treated as no speech, whatever the text.
NO_SPEECH_THRESHOLD = float(os.environ.get("REALTIME_NO_SPEECH_THRESHOLD", "0.6"))
_last_decode_results = []  # filled by the patched decode below; read under _gpu_lock
# The browser's voice detector also lets through music, clatter and hum, and
# Whisper writes text for those too. Silero VAD (bundled with faster-whisper)
# measured 0 ms of speech in noise, hum, chords, clicks and instrumental rock,
# and 380 ms or more in single words ("Hi.", "No.", "Boring."). Clips with less
# speech than this skip Whisper. 0 turns the check off.
VAD_MIN_SPEECH_MS = int(os.environ.get("REALTIME_VAD_MIN_SPEECH_MS", "250"))


def _decode_clip(path):
    """The clip as 16 kHz mono float32 numpy, decoded once for the voice check and for Whisper. The same
    samples Whisper's own loader got from the file (ffmpeg for MLX, PyAV for faster-whisper); decoding it
    three times (voice check, ffmpeg to WAV, Whisper reading the WAV) cost about 75 ms per turn.

    lightning-whisper-mlx's loader returns a lazy MLX array (the conversion to float is queued for the
    GPU), so turning it into numpy runs on the GPU: under _gpu_lock. Done outside it, it crashed this
    service twice on 10 Nov while another request's Whisper ran (Metal: "A command encoder is already
    encoding to this command buffer", then a segfault)."""
    if STT_BACKEND == "mlx":
        from lightning_whisper_mlx.audio import load_audio
        with _gpu_lock:
            return np.asarray(load_audio(path), dtype=np.float32)
    from faster_whisper.audio import decode_audio
    return decode_audio(path, sampling_rate=16000)


def _speech_ms(audio):
    """Milliseconds of speech Silero VAD finds in 16 kHz mono float audio."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    spans = get_speech_timestamps(audio, VadOptions(min_speech_duration_ms=0, speech_pad_ms=0))
    return sum(s["end"] - s["start"] for s in spans) / 16


def _speech_text(text, no_speech_probs):
    """The transcript, or "" when every decoded window says there was no speech."""
    probs = [p for p in no_speech_probs if p == p]  # drop NaN
    if probs and min(probs) >= NO_SPEECH_THRESHOLD:
        return ""
    return text


def _capture_decode_results(stt):
    """lightning-whisper-mlx computes no_speech_prob per window but only returns the
    text; record the decode results so /transcribe can use them."""
    from lightning_whisper_mlx import whisper as lw
    if getattr(lw.Whisper.decode, "_tubs_capture", False):
        return
    original = lw.Whisper.decode

    def decode(self, *args, **kwargs):
        results = original(self, *args, **kwargs)
        # Temperature fallback decodes again; the last call holds the final results.
        _last_decode_results[:] = results if isinstance(results, list) else [results]
        return results

    decode._tubs_capture = True
    lw.Whisper.decode = decode

stt_model = None
tts_model = None


def trim_silence(audio, sample_rate=24000, lead_keep_s=0.04, tail_keep_s=0.28, rel_threshold=0.02):
    """Kokoro pads every clip with ~0.5 s of silence at both ends. Streamed
    sentence by sentence, that made the first word arrive half a second late
    and left ~1.1 s of dead air between sentences. Keep a short natural pause."""
    if audio.size == 0:
        return audio
    peak = float(np.max(np.abs(audio)))
    if peak <= 0:
        return audio
    voiced = np.flatnonzero(np.abs(audio) > peak * rel_threshold)
    if voiced.size == 0:
        return audio
    start = max(0, int(voiced[0]) - int(lead_keep_s * sample_rate))
    end = min(audio.size, int(voiced[-1]) + int(tail_keep_s * sample_rate))
    return audio[start:end]


def pcm_to_wav_bytes(pcm_float32, sample_rate=24000):
    pcm_int16 = np.clip(pcm_float32 * 32767, -32768, 32767).astype(np.int16)
    num_samples = len(pcm_int16)
    data_size = num_samples * 2

    buf = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_size))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))
    buf.write(struct.pack("<H", 1))
    buf.write(struct.pack("<H", 1))
    buf.write(struct.pack("<I", sample_rate))
    buf.write(struct.pack("<I", sample_rate * 2))
    buf.write(struct.pack("<H", 2))
    buf.write(struct.pack("<H", 16))
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    buf.write(pcm_int16.tobytes())
    return buf.getvalue()

def _safe_numpy(audio_obj):
    if hasattr(audio_obj, "cpu"):
        audio_obj = audio_obj.cpu()
    if hasattr(audio_obj, "numpy"):
        return audio_obj.numpy()
    return np.array(audio_obj)



def ensure_stt_model():
    global stt_model
    if stt_model is not None:
        return stt_model

    if STT_BACKEND == "mlx":
        from lightning_whisper_mlx import LightningWhisperMLX
        print(f"[Realtime STT] Loading lightning-whisper-mlx: {STT_MODEL}")
        stt_model = LightningWhisperMLX(model=STT_MODEL, batch_size=12)
        _capture_decode_results(stt_model)
    else:
        from faster_whisper import WhisperModel
        print(f"[Realtime STT] Loading faster-whisper: {STT_MODEL} on cpu (int8)")
        stt_model = WhisperModel(STT_MODEL, device="cpu", compute_type="int8")
    print("[Realtime STT] Ready")
    return stt_model


def ensure_tts_model():
    global tts_model
    if tts_model is not None:
        return tts_model

    if TTS_BACKEND in {"kokoro", "kokoro_streaming"}:
        if _KOKORO_BACKEND == "mlx":
            # macOS: MLX-accelerated
            from mlx_audio.tts.utils import load_model as load_tts_model
            print(f"[Realtime TTS] Loading Kokoro via mlx_audio (voice={KOKORO_VOICE})")
            tts_model = load_tts_model("mlx-community/Kokoro-82M-bf16")
            print("[Realtime TTS] Kokoro (mlx_audio) ready")
        else:
            # Windows / Linux: KPipeline (ONNX/CPU, requires espeak-ng)
            from kokoro import KPipeline
            print(f"[Realtime TTS] Loading Kokoro via KPipeline (voice={KOKORO_VOICE})")
            tts_model = KPipeline(lang_code="a")
            print("[Realtime TTS] Kokoro (KPipeline) ready")
    else:
        print("[Realtime TTS] Using system TTS")
        tts_model = "system"
    return tts_model

def warm_up_tts():
    """Run one tiny synthesis so the first real reply doesn't pay for building
    the language pipeline and compiling kernels (about a second on the first
    request otherwise)."""
    started = time.time()
    # A Ming voice isn't a Kokoro voice: warm up the head that speaks with Kokoro.
    voice = next(v for v in _configured_voices() if not v.startswith("ming:"))
    try:
        model = ensure_tts_model()
        if _KOKORO_BACKEND == "mlx":
            with _gpu_lock:
                for _ in model.generate(text="Ready.", voice=voice, speed=1.0, lang_code="a"):
                    pass
        else:
            for _ in model("Ready.", voice=voice, speed=1.0):
                pass
        print(f"[Realtime TTS] Warm-up done in {time.time() - started:.2f}s")
    except Exception as err:
        print("[Realtime TTS] Warm-up failed:", err)


def normalize_audio_mime_type(value):
    normalized = str(value or "").lower()
    if "audio/wav" in normalized or "audio/x-wav" in normalized or "audio/wave" in normalized:
        return "audio/wav"
    return "audio/webm"


def parts_to_text(parts):
    chunks = []
    for part in parts or []:
        if not isinstance(part, dict):
            continue
        text = part.get("text")
        if isinstance(text, str) and text.strip():
            chunks.append(text.strip())
            continue
        if part.get("inline_data"):
            chunks.append("[image omitted]")
    return "\n".join(chunks).strip()


def build_messages(system_instruction, contents):
    messages = []
    if isinstance(system_instruction, str) and system_instruction.strip():
        messages.append({"role": "system", "content": system_instruction.strip()})

    for item in contents or []:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role", "user")).strip().lower()
        mapped_role = "assistant" if role == "model" else role if role in {"user", "assistant", "system"} else "user"
        text = parts_to_text(item.get("parts") or [])
        if text:
            messages.append({"role": mapped_role, "content": text})
    return messages


def normalize_response_schema(schema):
    if not isinstance(schema, dict):
        return None

    type_map = {
        "OBJECT": "object",
        "ARRAY": "array",
        "STRING": "string",
        "NUMBER": "number",
        "INTEGER": "integer",
        "BOOLEAN": "boolean",
        "NULL": "null",
    }

    def walk(node):
        if isinstance(node, dict):
            out = {}
            for key, value in node.items():
                if key == "type" and isinstance(value, str):
                    mapped = type_map.get(value.upper())
                    out[key] = mapped or value.lower()
                else:
                    out[key] = walk(value)
            return out
        if isinstance(node, list):
            return [walk(item) for item in node]
        return node

    normalized = walk(schema)
    if not isinstance(normalized, dict):
        return None
    return normalized


def http_json_post(url, payload, headers=None, timeout=45):
    merged_headers = {"Content-Type": "application/json"}
    if headers:
        merged_headers.update(headers)
    request_obj = urllib.request.Request(
        url=url,
        data=json.dumps(payload).encode("utf-8"),
        headers=merged_headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request_obj, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return response.getcode(), raw
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        return err.code, body


def ollama_list_models():
    try:
        req = urllib.request.Request(
            url=f"{LLM_BASE_URL}/api/tags",
            headers={"Content-Type": "application/json"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            raw = response.read().decode("utf-8")
        parsed = json.loads(raw)
        models = []
        for item in (parsed.get("models") or []):
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or item.get("model") or "").strip()
            if name:
                models.append(name)
        return models
    except Exception:
        return []


def ollama_generate(model, messages, temperature, max_output_tokens, response_mime_type="", response_schema=None):
    options = {"temperature": temperature}
    if max_output_tokens:
        options["num_predict"] = int(max_output_tokens)
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": options,
    }
    if isinstance(response_schema, dict) and response_schema:
        payload["format"] = response_schema
    elif response_mime_type == "application/json":
        payload["format"] = "json"

    status, raw = http_json_post(f"{LLM_BASE_URL}/api/chat", payload, timeout=90)
    if status < 200 or status >= 300:
        detail = raw[:400]
        if status == 404 and "not found" in raw.lower():
            available = ollama_list_models()
            if available:
                preview = ", ".join(available[:8])
                detail = f"{detail} | available models: {preview}"
            else:
                detail = f"{detail} | no local models found from /api/tags"
        raise RuntimeError(f"Ollama error ({status}): {detail}")
    data = json.loads(raw)
    text = str(((data.get("message") or {}).get("content") or "")).strip()
    usage = {
        "promptTokenCount": int(data.get("prompt_eval_count") or 0),
        "candidatesTokenCount": int(data.get("eval_count") or 0),
    }
    return text, usage, str(data.get("model") or model)


def openai_generate(model, messages, temperature, max_output_tokens):
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is required when REALTIME_LLM_PROVIDER=openai")
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    if max_output_tokens:
        payload["max_tokens"] = int(max_output_tokens)
    status, raw = http_json_post(
        f"{OPENAI_BASE_URL}/chat/completions",
        payload,
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        timeout=90,
    )
    if status < 200 or status >= 300:
        raise RuntimeError(f"OpenAI error ({status}): {raw[:400]}")
    data = json.loads(raw)
    choices = data.get("choices") or []
    content = ""
    if choices:
        content = str((((choices[0] or {}).get("message") or {}).get("content") or "")).strip()
    usage_raw = data.get("usage") or {}
    usage = {
        "promptTokenCount": int(usage_raw.get("prompt_tokens") or 0),
        "candidatesTokenCount": int(usage_raw.get("completion_tokens") or 0),
    }
    return content, usage, str(data.get("model") or model)


def _extract_openai_stream_delta(chunk):
    choices = chunk.get("choices") or []
    if not choices:
        return ""
    delta = (choices[0] or {}).get("delta") or {}
    content = delta.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts = []
        for part in content:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if isinstance(text, str) and text:
                text_parts.append(text)
        return "".join(text_parts)
    return ""


def ollama_stream_generate(model, messages, temperature, max_output_tokens, response_mime_type="", response_schema=None):
    options = {"temperature": temperature}
    if max_output_tokens:
        options["num_predict"] = int(max_output_tokens)
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": options,
    }
    if isinstance(response_schema, dict) and response_schema:
        payload["format"] = response_schema
    elif response_mime_type == "application/json":
        payload["format"] = "json"

    request_obj = urllib.request.Request(
        url=f"{LLM_BASE_URL}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request_obj, timeout=90) as response:
            resolved_model = model
            usage = {"promptTokenCount": 0, "candidatesTokenCount": 0}
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except Exception:
                    continue

                if data.get("model"):
                    resolved_model = str(data.get("model") or resolved_model)

                delta = str(((data.get("message") or {}).get("content") or ""))
                if delta:
                    yield {"delta": delta}

                if data.get("done"):
                    usage = {
                        "promptTokenCount": int(data.get("prompt_eval_count") or 0),
                        "candidatesTokenCount": int(data.get("eval_count") or 0),
                    }
                    yield {"done": True, "usage": usage, "model": resolved_model}
                    return

            yield {"done": True, "usage": usage, "model": resolved_model}
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        detail = body[:400]
        if err.code == 404 and "not found" in body.lower():
            available = ollama_list_models()
            if available:
                preview = ", ".join(available[:8])
                detail = f"{detail} | available models: {preview}"
            else:
                detail = f"{detail} | no local models found from /api/tags"
        raise RuntimeError(f"Ollama stream error ({err.code}): {detail}")


def openai_stream_generate(model, messages, temperature, max_output_tokens):
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is required when REALTIME_LLM_PROVIDER=openai")

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if max_output_tokens:
        payload["max_tokens"] = int(max_output_tokens)

    request_obj = urllib.request.Request(
        url=f"{OPENAI_BASE_URL}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENAI_API_KEY}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request_obj, timeout=90) as response:
            resolved_model = model
            usage = {"promptTokenCount": 0, "candidatesTokenCount": 0}

            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line or not line.startswith("data:"):
                    continue

                data_text = line[5:].strip()
                if not data_text:
                    continue
                if data_text == "[DONE]":
                    break

                try:
                    chunk = json.loads(data_text)
                except Exception:
                    continue

                if chunk.get("model"):
                    resolved_model = str(chunk.get("model") or resolved_model)

                usage_raw = chunk.get("usage") or {}
                if usage_raw:
                    usage = {
                        "promptTokenCount": int(usage_raw.get("prompt_tokens") or usage.get("promptTokenCount") or 0),
                        "candidatesTokenCount": int(usage_raw.get("completion_tokens") or usage.get("candidatesTokenCount") or 0),
                    }

                delta = _extract_openai_stream_delta(chunk)
                if delta:
                    yield {"delta": delta}

            yield {"done": True, "usage": usage, "model": resolved_model}
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI stream error ({err.code}): {body[:400]}")


def resolve_llm_request(payload):
    model = str(payload.get("model") or "llama3.1:8b")
    system_instruction = payload.get("systemInstruction") or ""
    contents = payload.get("contents") or []
    temperature = float(payload.get("temperature") if payload.get("temperature") is not None else 0.7)
    max_output_tokens = payload.get("maxOutputTokens") or 256
    provider = str(payload.get("provider") or LLM_PROVIDER).strip().lower()
    response_mime_type = str(payload.get("responseMimeType") or "").strip().lower()
    response_schema = normalize_response_schema(payload.get("responseSchema"))

    if not isinstance(system_instruction, str) or not system_instruction.strip():
        raise RuntimeError(
            "systemInstruction is required for realtime LLM requests (persona prompt missing)."
        )

    messages = build_messages(system_instruction, contents)
    if not messages:
        messages = [{"role": "user", "content": "Say hello in one short sentence."}]

    return {
        "model": model,
        "system_instruction": system_instruction,
        "temperature": temperature,
        "max_output_tokens": max_output_tokens,
        "provider": provider,
        "response_mime_type": response_mime_type,
        "response_schema": response_schema,
        "messages": messages,
    }


def llm_generate(payload):
    req = resolve_llm_request(payload)
    print(
        f"[Realtime LLM] provider={req['provider']} model={req['model']} messages={len(req['messages'])} "
        f"systemChars={len(req['system_instruction'].strip())} format={'schema' if req['response_schema'] else req['response_mime_type'] or 'text'}"
    )

    if req["provider"] == "openai":
        text, usage, resolved_model = openai_generate(
            req["model"],
            req["messages"],
            req["temperature"],
            req["max_output_tokens"],
        )
    else:
        text, usage, resolved_model = ollama_generate(
            req["model"],
            req["messages"],
            req["temperature"],
            req["max_output_tokens"],
            response_mime_type=req["response_mime_type"],
            response_schema=req["response_schema"],
        )

    return {
        "text": text,
        "usage": usage,
        "model": resolved_model,
        "provider": req["provider"],
    }


def llm_stream(payload):
    req = resolve_llm_request(payload)
    print(
        f"[Realtime LLM:stream] provider={req['provider']} model={req['model']} messages={len(req['messages'])} "
        f"systemChars={len(req['system_instruction'].strip())} format={'schema' if req['response_schema'] else req['response_mime_type'] or 'text'}"
    )
    if req["provider"] == "openai":
        yield from openai_stream_generate(
            req["model"],
            req["messages"],
            req["temperature"],
            req["max_output_tokens"],
        )
        return

    yield from ollama_stream_generate(
        req["model"],
        req["messages"],
        req["temperature"],
        req["max_output_tokens"],
        response_mime_type=req["response_mime_type"],
        response_schema=req["response_schema"],
    )


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "port": PORT,
        "stt_model": STT_MODEL,
        "stt_backend": STT_BACKEND,
        "tts_backend": TTS_BACKEND,
        "llm_provider": LLM_PROVIDER,
    })


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]
    mime = normalize_audio_mime_type(audio_file.mimetype)
    suffix = ".wav" if mime == "audio/wav" else ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    t0 = time.time()
    try:
        if os.path.getsize(tmp_path) < MIN_STT_AUDIO_BYTES:
            return jsonify({
                "text": "",
                "language": "en",
                "probability": 0.0,
            })

        try:
            audio = _decode_clip(tmp_path)
        except Exception as err:
            print(f"[Realtime STT] could not decode the clip ({err}) - empty segment")
            return jsonify({
                "text": "",
                "language": "en",
                "probability": 0.0,
            })

        if VAD_MIN_SPEECH_MS > 0:
            try:
                voice_ms = _speech_ms(np.asarray(audio, dtype=np.float32))
            except Exception as err:
                voice_ms = None
                print(f"[Realtime STT] voice check failed, sending to Whisper anyway: {err}")
            if voice_ms is not None and voice_ms < VAD_MIN_SPEECH_MS:
                print(f"[Realtime STT] no voice ({voice_ms:.0f} ms of speech), skipped Whisper")
                return jsonify({
                    "text": "",
                    "language": "en",
                    "probability": 0.0,
                })

        model = ensure_stt_model()

        if STT_BACKEND == "mlx":
            with _gpu_lock:
                _last_decode_results.clear()
                result = model.transcribe(audio, language="en")
                no_speech = [float(getattr(r, "no_speech_prob", float("nan"))) for r in _last_decode_results]
            heard = str(result.get("text", "")).strip()
            text = _speech_text(heard, no_speech)
            elapsed = int((time.time() - t0) * 1000)
            if heard and not text:
                print(f"[Realtime STT] no speech (no_speech_prob {min(no_speech):.2f}), dropped in {elapsed}ms: {heard[:80]}")
            else:
                print(f"[Realtime STT] mlx transcribed in {elapsed}ms: {text[:80]}")
            return jsonify({
                "text": text,
                "language": "en",
                "probability": 1.0,
            })
        else:
            segments, info = model.transcribe(audio, beam_size=1, language="en")
            # Same rule per segment: faster-whisper returns no_speech_prob with each one.
            text = " ".join([s.text for s in segments if _speech_text(s.text, [s.no_speech_prob])]).strip()
            elapsed = int((time.time() - t0) * 1000)
            print(f"[Realtime STT] faster-whisper transcribed in {elapsed}ms: {text[:80]}")
            return jsonify({
                "text": text,
                "language": getattr(info, "language", "en"),
                "probability": float(getattr(info, "language_probability", 1.0) or 1.0),
            })
    except Exception as err:
        return jsonify({"error": str(err)}), 500
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


# Cloned voices ("ming:...") are rendered by a separate Ming service. It needs
# a newer mlx than this process (speech-to-text), so it runs in its own venv.
MING_TTS_URL = os.environ.get("MING_TTS_URL", "http://127.0.0.1:3003").rstrip("/")
# When Ming is down or still loading, a ming: voice fails with an error, never
# with another voice: a Kokoro voice standing in hid that Ming was broken.


def _configured_voices():
    """Main's voice and Mini's (the server passes both)."""
    return (KOKORO_VOICE, os.environ.get("SECONDARY_VOICE") or KOKORO_VOICE)


def _ming_error(voice, err):
    """What went wrong, in words the operator can act on (Ming's own reason when it gave one)."""
    detail = str(err)
    if isinstance(err, urllib.error.HTTPError):
        try:
            detail = json.loads(err.read() or b"{}").get("error") or detail
        except Exception:
            pass
    elif isinstance(err, urllib.error.URLError):
        detail = f"no Ming service at {MING_TTS_URL} ({err.reason})"
    return f"Ming could not speak {voice}: {detail}"


def _ming_body(text, voice):
    # "ming:friend-b" is voice "friend-b" in the Ming service.
    return json.dumps({"text": text, "voice": voice.split(":", 1)[1] or "friend"}).encode("utf-8")


def _ming_wav(text, voice="ming:friend"):
    req = urllib.request.Request(
        f"{MING_TTS_URL}/tts",
        data=_ming_body(text, voice),
        headers={"content-type": "application/json"},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=60) as resp:
        wav_bytes = resp.read()
        render_ms = resp.headers.get("X-Render-Ms", "?")
    print(f"[Realtime TTS] Ming {len(text)} chars in {int((time.time() - t0) * 1000)}ms (render {render_ms}ms)")
    return wav_bytes


def _ming_stream(text, voice="ming:friend"):
    """Yields (base64 WAV, last) for each chunk of Ming's /tts/stream as it arrives.
    Raises if Ming fails before or during the stream (down, HTTP error, an
    {"error"} line, or the stream cut off before its done line)."""
    req = urllib.request.Request(
        f"{MING_TTS_URL}/tts/stream",
        data=_ming_body(text, voice),
        headers={"content-type": "application/json"},
    )
    t0 = time.time()
    chunks, first_ms = 0, None
    with urllib.request.urlopen(req, timeout=60) as resp:
        for line in resp:
            if not line.strip():
                continue
            msg = json.loads(line)
            if msg.get("error"):
                raise RuntimeError(f"Ming stream error: {msg['error']}")
            if msg.get("done"):
                print(f"[Realtime TTS] Ming stream {len(text)} chars: {chunks} chunk(s), first after {first_ms}ms, "
                      f"done in {int((time.time() - t0) * 1000)}ms (render {msg.get('render_ms', '?')}ms, "
                      f"{msg.get('audio_s', '?')}s audio)")
                return
            if isinstance(msg.get("audio"), str) and msg["audio"]:
                if chunks == 0:
                    first_ms = int((time.time() - t0) * 1000)
                chunks += 1
                yield msg["audio"], bool(msg.get("last"))
    raise RuntimeError(f"Ming stream ended after {chunks} chunk(s) without its done line")


def _send_ming_stream(ws, text, voice="ming:friend"):
    """Speaks text with Ming over the TTS socket: one {"text","audio","chunk"}
    message per chunk as Ming renders it ("more" on all but the last, so the
    client keeps one subtitle across them), then done. If Ming produces no
    audio at all, an {"error"} goes out before the done, so the turn fails
    loudly. A stream that dies midway ends the reply there; the done still goes
    out so the turn doesn't wait for it."""
    stream = _ming_stream(text, voice)
    sent, failure = 0, None
    try:
        while True:
            try:
                audio, last = next(stream)
            except StopIteration:
                break
            except Exception as err:
                if sent:
                    print(f"[Realtime TTS] Ming stream failed after {sent} chunk(s) ({err}); reply ends there")
                    break
                if not (isinstance(err, urllib.error.HTTPError) and err.code == 404):
                    failure = err
                    break
                # A Ming service without /tts/stream (the older ming_service.py): the whole reply in one chunk.
                try:
                    audio, last = base64.b64encode(_ming_wav(text, voice)).decode("ascii"), True
                except Exception as old_err:
                    failure = old_err
                    break
            message = {"text": text, "audio": audio, "chunk": True}
            if not last:
                message["more"] = True
            ws.send(json.dumps(message))  # a closed socket raises here; finally cancels the Ming render
            sent += 1
    finally:
        stream.close()
    if not sent:
        message = _ming_error(voice, failure or "it sent no audio")
        print(f"[Realtime TTS] ERROR: {message}")
        ws.send(json.dumps({"error": message}))
    ws.send(json.dumps({"text": text, "done": True}))


@app.route("/tts", methods=["POST"])
def tts():
    data = request.json or {}
    text = str(data.get("text") or "").strip()
    voice = str(data.get("voice") or KOKORO_VOICE).strip().lower()
    if not text:
        return jsonify({"error": "No text provided"}), 400

    if voice.startswith("ming:"):
        try:
            return Response(_ming_wav(text, voice), mimetype="audio/wav")
        except Exception as err:
            message = _ming_error(voice, err)
            print(f"[Realtime TTS] ERROR: {message}")
            return jsonify({"error": message}), 503

    if TTS_BACKEND in {"kokoro", "kokoro_streaming"}:
        return _tts_kokoro(text, voice)
    else:
        return _tts_system(text)



def _tts_kokoro(text, voice):
    t0 = time.time()
    try:
        model = ensure_tts_model()
        segments = []

        if _KOKORO_BACKEND == "mlx":
            # macOS: mlx_audio — GPU lock required (Metal not thread-safe)
            with _gpu_lock:
                for result in model.generate(
                    text=text,
                    voice=voice,
                    speed=1.0,
                    lang_code="a",
                ):
                    segments.append(_safe_numpy(result.audio))
        else:
            # Windows / Linux: kokoro KPipeline
            for _, _, audio in model(text, voice=voice, speed=1.0):
                segments.append(_safe_numpy(audio))

        if not segments:
            return jsonify({"error": "Kokoro generated no audio"}), 500
        audio = trim_silence(np.concatenate(segments))
        wav_bytes = pcm_to_wav_bytes(audio, sample_rate=24000)
        elapsed = int((time.time() - t0) * 1000)
        backend_label = f"Kokoro/{_KOKORO_BACKEND}"
        print(f"[Realtime TTS] {backend_label} generated {len(wav_bytes)} bytes in {elapsed}ms (voice={voice})")
        return Response(wav_bytes, mimetype="audio/wav")
    except Exception as err:
        print(f"[Realtime TTS] Kokoro error (voice={voice}): {err}")
        traceback.print_exc()
        return jsonify({"error": str(err)}), 500

def _tts_system(text):
    """Cross-platform system TTS (ported from the old transcription service).
    On macOS: the native say/afconvert pipeline. Elsewhere, or if say fails:
    pyttsx3 (Windows SAPI5 / espeak on Linux)."""
    import uuid, tempfile, subprocess, platform
    filename = f"realtime_tts_{uuid.uuid4().hex}"
    aiff_path = os.path.join(tempfile.gettempdir(), filename + ".aiff")
    wav_path = os.path.join(tempfile.gettempdir(), filename + ".wav")
    try:
        if platform.system() == "Darwin":
            try:
                subprocess.run(["say", "-o", aiff_path, text], check=True, timeout=12)
                subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", "-r", "22050", aiff_path, wav_path], check=True, timeout=6)
                with open(wav_path, "rb") as f:
                    audio_data = f.read()
                print(f"[Realtime TTS] System generated {len(audio_data)} bytes (macOS say)")
                return Response(audio_data, mimetype="audio/wav")
            except Exception as err:
                print(f"[Realtime TTS] macOS say failed ({err}), falling back to pyttsx3")

        import pyttsx3
        engine = pyttsx3.init()
        engine.save_to_file(text, wav_path)
        engine.runAndWait()
        engine.stop()
        if not os.path.exists(wav_path) or os.path.getsize(wav_path) == 0:
            return jsonify({"error": "pyttsx3 TTS produced no audio"}), 500
        with open(wav_path, "rb") as f:
            audio_data = f.read()
        print(f"[Realtime TTS] System generated {len(audio_data)} bytes (pyttsx3)")
        return Response(audio_data, mimetype="audio/wav")
    except Exception as err:
        return jsonify({"error": str(err)}), 500
    finally:
        if os.path.exists(aiff_path):
            os.remove(aiff_path)
        if os.path.exists(wav_path):
            os.remove(wav_path)

@sock.route("/tts/stream")
def tts_stream(ws):
    import traceback
    import base64
    import threading
    voice = KOKORO_VOICE
    
    while True:
        raw = ws.receive()
        if not raw: break
        text = ""
        try:
            data = json.loads(raw)
            text = str(data.get("text") or "").strip()
            voice = str(data.get("voice") or voice).strip().lower()
            if not text:
                continue

            if voice.startswith("ming:"):
                _send_ming_stream(ws, text, voice)
                continue
            
            if TTS_BACKEND in {"kokoro", "kokoro_streaming"}:
                m = ensure_tts_model()  # loaded on the first Kokoro voice (not at all with both heads on Ming)
                segments = []
                if _KOKORO_BACKEND == "mlx":
                    # macOS: mlx_audio — GPU lock required
                    with _gpu_lock:
                        for result in m.generate(text=text, voice=voice, speed=1.0, lang_code="a"):
                            segments.append(_safe_numpy(result.audio))
                else:
                    # Windows / Linux: kokoro KPipeline
                    for _, _, audio in m(text, voice=voice, speed=1.0):
                        segments.append(_safe_numpy(audio))
                if not segments:
                    ws.send(json.dumps({"error": "Kokoro generated no audio"}))
                    # The server counts sentences by "done"; without it the turn waits 30 s.
                    ws.send(json.dumps({"text": text, "done": True}))
                    continue
                wav_bytes = pcm_to_wav_bytes(trim_silence(np.concatenate(segments)), sample_rate=24000)
                ws.send(json.dumps({
                    "text": text,
                    "audio": base64.b64encode(wav_bytes).decode('ascii'),
                    "chunk": True
                }))
                ws.send(json.dumps({"text": text, "done": True}))
            else:
                ws.send(json.dumps({"error": "Streaming not supported by " + TTS_BACKEND}))
                
        except Exception as err:
            print("[TTS Stream] Error:", err)
            traceback.print_exc()
            ws.send(json.dumps({"error": str(err)}))
            ws.send(json.dumps({"text": text, "done": True}))


@app.route("/llm/generate", methods=["POST"])
def llm_generate_route():
    payload = request.json or {}
    try:
        result = llm_generate(payload)
        return jsonify(result)
    except Exception as err:
        return jsonify({"error": str(err)}), 500


@app.route("/llm/stream", methods=["POST"])
def llm_stream_route():
    payload = request.json or {}
    try:
        def generate():
            done_sent = False
            usage = {}
            model = None
            try:
                for event in llm_stream(payload):
                    if not isinstance(event, dict):
                        continue
                    if event.get("usage"):
                        usage = event.get("usage") or usage
                    if event.get("model"):
                        model = event.get("model")
                    if event.get("done"):
                        done_sent = True
                    yield json.dumps(event) + "\n"
            except Exception as err:
                yield json.dumps({"error": str(err), "done": True}) + "\n"
                return

            if not done_sent:
                yield json.dumps({
                    "done": True,
                    "usage": usage,
                    "model": model,
                }) + "\n"

        return Response(generate(), mimetype="application/x-ndjson")
    except Exception as err:
        return jsonify({"error": str(err)}), 500


if __name__ == "__main__":
    print(
        f"Starting realtime processing service on port {PORT} "
        f"(STT={STT_BACKEND}:{STT_MODEL}, TTS={TTS_BACKEND}, LLM={LLM_PROVIDER})"
    )
    # With both heads on Ming (ming:*) nothing speaks with Kokoro; it loads
    # only if a Kokoro voice is picked later (a few seconds, once).
    if TTS_BACKEND in {"kokoro", "kokoro_streaming"} and all(v.startswith("ming:") for v in _configured_voices()):
        print("[Realtime TTS] Both voices are Ming; Kokoro not loaded")
    elif TTS_BACKEND in {"kokoro", "kokoro_streaming"}:
        print("[Realtime TTS] Preloading model before accepting requests")
        ensure_tts_model()
        warm_up_tts()
    elif TTS_BACKEND == "system":
        print("[Realtime TTS] System backend selected")
    # Load Whisper now too; otherwise the first voice turn after a restart
    # waits for the model to load.
    ensure_stt_model()
    if VAD_MIN_SPEECH_MS > 0:
        _speech_ms(np.zeros(16000, np.float32))  # loads Silero (about a second the first time)
    app.run(port=PORT)

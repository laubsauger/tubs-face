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

import numpy as np
from flask import Flask, Response, jsonify, request
from flask_sock import Sock

app = Flask(__name__)
sock = Sock(app)

_gpu_lock = threading.Lock()

PORT = int(os.environ.get("REALTIME_PROCESSING_PORT", "3002"))
STT_MODEL = os.environ.get("REALTIME_STT_MODEL", os.environ.get("WHISPER_MODEL", "small"))
STT_BACKEND = os.environ.get("REALTIME_STT_BACKEND", os.environ.get("STT_BACKEND", "mlx")).strip().lower()
TTS_BACKEND = os.environ.get("REALTIME_TTS_BACKEND", os.environ.get("TTS_BACKEND", "kokoro")).strip().lower()
KOKORO_VOICE = os.environ.get("REALTIME_KOKORO_VOICE", os.environ.get("KOKORO_VOICE", "hm_omega"))
LLM_PROVIDER = os.environ.get("REALTIME_LLM_PROVIDER", "ollama").strip().lower()
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

stt_model = None
tts_model = None


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


def ensure_stt_model():
    global stt_model
    if stt_model is not None:
        return stt_model

    if STT_BACKEND == "mlx":
        from lightning_whisper_mlx import LightningWhisperMLX
        print(f"[Realtime STT] Loading lightning-whisper-mlx: {STT_MODEL}")
        stt_model = LightningWhisperMLX(model=STT_MODEL, batch_size=12)
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

    if TTS_BACKEND == "vibevoice":
        from vibevoice import VibeVoiceStreamingForConditionalGenerationInference, VibeVoiceStreamingProcessor
        print("[Realtime TTS] Loading VibeVoice-Realtime-0.5B")
        processor = VibeVoiceStreamingProcessor.from_pretrained("microsoft/VibeVoice-Realtime-0.5B")
        model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
            "microsoft/VibeVoice-Realtime-0.5B",
            device_map="auto",
        )
        tts_model = (model, processor)
        print("[Realtime TTS] VibeVoice ready")
    elif TTS_BACKEND in {"kokoro", "kokoro_streaming"}:
        from mlx_audio.tts.utils import load_model as load_tts_model
        print(f"[Realtime TTS] Loading Kokoro (voice={KOKORO_VOICE})")
        tts_model = load_tts_model("mlx-community/Kokoro-82M-bf16")
        print("[Realtime TTS] Kokoro ready")
    else:
        print("[Realtime TTS] Using macOS system TTS (say)")
        tts_model = "system"
    return tts_model


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

        model = ensure_stt_model()

        if STT_BACKEND == "mlx":
            is_wav_input = tmp_path.lower().endswith(".wav")
            wav_path = tmp_path if is_wav_input else tmp_path.rsplit(".", 1)[0] + ".stt.wav"
            try:
                if not is_wav_input:
                    try:
                        subprocess.run(
                            ["ffmpeg", "-y", "-i", tmp_path, "-ar", "16000", "-ac", "1", wav_path],
                            check=True,
                            timeout=12,
                            capture_output=True,
                        )
                    except subprocess.CalledProcessError as err:
                        print(f"[Realtime STT] ffmpeg decode failed (code={err.returncode}) — empty segment")
                        return jsonify({
                            "text": "",
                            "language": "en",
                            "probability": 0.0,
                        })
                    except subprocess.TimeoutExpired:
                        print("[Realtime STT] ffmpeg decode timeout — empty segment")
                        return jsonify({
                            "text": "",
                            "language": "en",
                            "probability": 0.0,
                        })
                with _gpu_lock:
                    result = model.transcribe(wav_path, language="en")
                text = str(result.get("text", "")).strip()
                elapsed = int((time.time() - t0) * 1000)
                print(f"[Realtime STT] mlx transcribed in {elapsed}ms: {text[:80]}")
                return jsonify({
                    "text": text,
                    "language": "en",
                    "probability": 1.0,
                })
            finally:
                if not is_wav_input and os.path.exists(wav_path):
                    os.remove(wav_path)
        else:
            segments, info = model.transcribe(tmp_path, beam_size=1, language="en")
            text = " ".join([segment.text for segment in segments]).strip()
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


@app.route("/tts", methods=["POST"])
def tts():
    data = request.json or {}
    text = str(data.get("text") or "").strip()
    voice = str(data.get("voice") or KOKORO_VOICE).strip().lower()
    if not text:
        return jsonify({"error": "No text provided"}), 400

    if TTS_BACKEND == "vibevoice":
        return _tts_vibevoice(text)
    elif TTS_BACKEND in {"kokoro", "kokoro_streaming"}:
        return _tts_kokoro(text, voice)
    else:
        return _tts_system(text)

def _tts_vibevoice(text):
    t0 = time.time()
    try:
        model_holder = ensure_tts_model()
        m, p = model_holder
        import copy
        import torch
        
        global _vibevoice_cached_prompt
        if getattr(m, '_vibevoice_cached_prompt', None) is None:
            m._vibevoice_cached_prompt = torch.load("demo/voices/sp-Spk1_man.pt", map_location=m.device if hasattr(m, 'device') else 'cpu', weights_only=False)
            
        prefilled_outputs = copy.deepcopy(m._vibevoice_cached_prompt)
        inputs = p.process_input_with_cached_prompt(text=text, cached_prompt=prefilled_outputs, padding=True, return_tensors="pt", return_attention_mask=True)
        if hasattr(m, "device"):
            inputs = {k: v.to(m.device) for k,v in inputs.items() if hasattr(v, "to")}
        
        with _gpu_lock:
            # For non-streaming, we can just use normal generate
            out = m.generate(**inputs, tokenizer=p.tokenizer, all_prefilled_outputs=prefilled_outputs)
            audio_tensor = out.speech_outputs[0]
        
        if audio_tensor is None:
            raise ValueError("VibeVoice generated no audio")
            
        audio_np = audio_tensor.cpu().view(-1).numpy()
        wav_bytes = pcm_to_wav_bytes(audio_np, sample_rate=24000)
        elapsed = int((time.time() - t0) * 1000)
        print(f"[Realtime TTS] Generated {len(wav_bytes)} bytes in {elapsed}ms (VibeVoice)")
        return Response(wav_bytes, mimetype="audio/wav")

    except Exception as err:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(err)}), 500

def _tts_kokoro(text, voice):
    t0 = time.time()
    try:
        model = ensure_tts_model()
        with _gpu_lock:
            segments = []
            for result in model.generate(
                text=text,
                voice=voice,
                speed=1.0,
                lang_code="a",
            ):
                segments.append(np.array(result.audio))
        if not segments:
            return jsonify({"error": "Kokoro generated no audio"}), 500
        audio = np.concatenate(segments)
        wav_bytes = pcm_to_wav_bytes(audio, sample_rate=24000)
        elapsed = int((time.time() - t0) * 1000)
        print(f"[Realtime TTS] Kokoro generated {len(wav_bytes)} bytes in {elapsed}ms")
        return Response(wav_bytes, mimetype="audio/wav")
    except Exception as err:
        return jsonify({"error": str(err)}), 500

def _tts_system(text):
    import uuid, tempfile, subprocess
    filename = f"realtime_tts_{uuid.uuid4().hex}"
    aiff_path = os.path.join(tempfile.gettempdir(), filename + ".aiff")
    wav_path = os.path.join(tempfile.gettempdir(), filename + ".wav")
    try:
        subprocess.run(["say", "-o", aiff_path, text], check=True, timeout=12)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", "-r", "22050", aiff_path, wav_path], check=True, timeout=6)
        if not os.path.exists(wav_path):
            return jsonify({"error": "TTS conversion failed"}), 500
        with open(wav_path, "rb") as f:
            audio_data = f.read()
        print(f"[Realtime TTS] System generated {len(audio_data)} bytes")
        return Response(audio_data, mimetype="audio/wav")
    except subprocess.CalledProcessError as err:
        return jsonify({"error": f"TTS process failed: {err}"}), 500
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
    model_holder = ensure_tts_model()
    voice = KOKORO_VOICE
    
    while True:
        raw = ws.receive()
        if not raw: break
        try:
            data = json.loads(raw)
            text = str(data.get("text") or "").strip()
            voice = str(data.get("voice") or voice).strip().lower()
            if not text:
                continue
            
            if TTS_BACKEND == "vibevoice":
                m, p = model_holder
                import copy
                import torch
                
                global _vibevoice_cached_prompt
                if getattr(m, '_vibevoice_cached_prompt', None) is None:
                    m._vibevoice_cached_prompt = torch.load("demo/voices/sp-Spk1_man.pt", map_location=m.device if hasattr(m, 'device') else 'cpu', weights_only=False)
                
                prefilled_outputs = copy.deepcopy(m._vibevoice_cached_prompt)
                
                inputs = p.process_input_with_cached_prompt(text=text, cached_prompt=prefilled_outputs, padding=True, return_tensors="pt", return_attention_mask=True)
                if hasattr(m, "device"):
                    inputs = {k: v.to(m.device) for k,v in inputs.items() if hasattr(v, "to")}
                from vibevoice.modular.streamer import AudioStreamer
                streamer = AudioStreamer(batch_size=1, timeout=12.0)
                
                def generate_task():
                    try:
                        m.generate(**inputs, streamer=streamer, tokenizer=p.tokenizer, all_prefilled_outputs=prefilled_outputs)
                    except Exception as e:
                        print(f"[VibeVoice] Generation error: {e}")
                        streamer.end()
                threading.Thread(target=generate_task, daemon=True).start()
                
                for audio_batch in streamer:
                    audio_tensor = audio_batch[0].cpu().view(-1)
                    audio_np = audio_tensor.numpy()
                    wav_bytes = pcm_to_wav_bytes(audio_np, sample_rate=24000)
                    ws.send(json.dumps({
                        "text": text,
                        "audio": base64.b64encode(wav_bytes).decode('ascii'),
                        "chunk": True
                    }))
                
                ws.send(json.dumps({"text": text, "done": True}))

            elif TTS_BACKEND in {"kokoro", "kokoro_streaming"}:
                m = model_holder
                for result in m.generate(text=text, voice=voice, speed=1.0, lang_code="a"):
                    audio_np = np.array(result.audio)
                    wav_bytes = pcm_to_wav_bytes(audio_np, sample_rate=24000)
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
    app.run(port=PORT)

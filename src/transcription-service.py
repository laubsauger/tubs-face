import huggingface_hub.inference._generated.types.document_question_answering
import asyncio.queues
import os
import io
import struct
import tempfile
import time
import uuid
import subprocess
import threading
import numpy as np
from flask import Flask, request, jsonify, Response
from flask_sock import Sock

import platform as _platform

app = Flask(__name__)
sock = Sock(app)

# Metal/MLX is not thread-safe — serialize all GPU operations.
# On non-MLX platforms this lock is still used but has no real effect.
_gpu_lock = threading.Lock()

_IS_MACOS = _platform.system() == "Darwin"

# Configuration
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
STT_BACKEND = os.environ.get("STT_BACKEND", "mlx")
TTS_BACKEND = os.environ.get("TTS_BACKEND", "kokoro")
KOKORO_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")

# STT backend resolution: lightning-whisper-mlx is Apple Silicon only.
# Fall back to faster-whisper automatically on non-macOS.
if STT_BACKEND == "mlx" and not _IS_MACOS:
    print("[STT] WARNING: STT_BACKEND=mlx is Apple Silicon only — falling back to faster-whisper.")
    STT_BACKEND = "faster-whisper"

# Kokoro can run on any platform:
#   macOS       → mlx_audio (MLX-accelerated, fast)
#   Windows/Linux → kokoro PyPI package (KPipeline, ONNX/CPU)
# _KOKORO_BACKEND tracks which implementation is active.
_KOKORO_BACKEND = "mlx" if _IS_MACOS else "native"

stt_model = None
tts_model = None

# --- STT Setup ---
if STT_BACKEND == "mlx":
    from lightning_whisper_mlx import LightningWhisperMLX

    print(f"[STT] Loading lightning-whisper-mlx: {MODEL_SIZE}")
    try:
        stt_model = LightningWhisperMLX(model=MODEL_SIZE, batch_size=12)
        print(f"[STT] lightning-whisper-mlx loaded successfully.")
    except Exception as e:
        print(f"[STT] Error loading lightning-whisper-mlx: {e}")
        raise
else:
    from faster_whisper import WhisperModel

    print(f"[STT] Loading faster-whisper: {MODEL_SIZE} on cpu (int8)")
    try:
        stt_model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
        print(f"[STT] faster-whisper loaded successfully.")
    except Exception as e:
        print(f"[STT] Error loading faster-whisper: {e}")
        raise

# --- TTS Setup ---
if TTS_BACKEND == "vibevoice":
    from vibevoice import VibeVoiceStreamingForConditionalGenerationInference, VibeVoiceStreamingProcessor
    print("[TTS] Loading VibeVoice-0.5B-Realtime...")
    try:
        processor = VibeVoiceStreamingProcessor.from_pretrained("microsoft/VibeVoice-Realtime-0.5B")
        tts_model_instance = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
            "microsoft/VibeVoice-Realtime-0.5B",
            device_map="auto"
        )
        tts_model = (tts_model_instance, processor)
        print("[TTS] VibeVoice loaded successfully.")
    except Exception as e:
        print(f"[TTS] Error loading VibeVoice: {e}")
        raise
elif TTS_BACKEND == "kokoro":
    if _KOKORO_BACKEND == "mlx":
        # macOS: use MLX-accelerated mlx_audio backend
        from mlx_audio.tts.utils import load_model as load_tts_model
        print(f"[TTS] Loading Kokoro via mlx_audio (voice={KOKORO_VOICE})...")
        try:
            tts_model = load_tts_model("mlx-community/Kokoro-82M-bf16")
            print(f"[TTS] Kokoro (mlx_audio) loaded successfully.")
        except Exception as e:
            print(f"[TTS] Error loading Kokoro (mlx_audio): {e}")
            raise
    else:
        # Windows / Linux: use kokoro PyPI package (KPipeline, ONNX/CPU)
        from kokoro import KPipeline
        print(f"[TTS] Loading Kokoro via KPipeline (voice={KOKORO_VOICE})...")
        try:
            tts_model = KPipeline(lang_code="a")
            print(f"[TTS] Kokoro (KPipeline) loaded successfully.")
        except Exception as e:
            print(f"[TTS] Error loading Kokoro (KPipeline): {e}")
            raise
else:
    print(f"[TTS] Using system TTS (pyttsx3 / macOS say)")




def pcm_to_wav_bytes(pcm_float32, sample_rate=24000):
    """Convert float32 PCM numpy array to WAV bytes (16-bit)."""
    pcm_int16 = np.clip(pcm_float32 * 32767, -32768, 32767).astype(np.int16)
    num_samples = len(pcm_int16)
    data_size = num_samples * 2  # 16-bit = 2 bytes per sample

    buf = io.BytesIO()
    # RIFF header
    buf.write(b'RIFF')
    buf.write(struct.pack('<I', 36 + data_size))
    buf.write(b'WAVE')
    # fmt chunk
    buf.write(b'fmt ')
    buf.write(struct.pack('<I', 16))         # chunk size
    buf.write(struct.pack('<H', 1))          # PCM format
    buf.write(struct.pack('<H', 1))          # mono
    buf.write(struct.pack('<I', sample_rate))
    buf.write(struct.pack('<I', sample_rate * 2))  # byte rate
    buf.write(struct.pack('<H', 2))          # block align
    buf.write(struct.pack('<H', 16))         # bits per sample
    # data chunk
    buf.write(b'data')
    buf.write(struct.pack('<I', data_size))
    buf.write(pcm_int16.tobytes())

    return buf.getvalue()

@app.route('/tts', methods=['POST'])
def tts():
    data = request.json
    text = data.get('text', '')
    voice = data.get('voice', KOKORO_VOICE)
    if not text:
        return jsonify({"error": "No text provided"}), 400

    if TTS_BACKEND == "vibevoice":
        return _tts_vibevoice(text)
    elif TTS_BACKEND == "kokoro":
        return _tts_kokoro(text, voice)
    else:
        return _tts_system(text)

def _tts_vibevoice(text):
    t0 = time.time()
    try:
        m, p = tts_model
        
        # Load the default voice prompt locally.
        import torch
        prefilled_outputs = torch.load("demo/voices/sp-Spk1_man.pt", map_location=m.device if hasattr(m, 'device') else 'cpu', weights_only=False)
        
        inputs = p.process_input_with_cached_prompt(text=text, cached_prompt=prefilled_outputs, padding=True, return_tensors="pt", return_attention_mask=True)
        if hasattr(m, "device"):
            inputs = {k: v.to(m.device) for k,v in inputs.items() if hasattr(v, "to")}
        
        with _gpu_lock:
            audio_tensor = m.generate(**inputs, tokenizer=p.tokenizer, all_prefilled_outputs=prefilled_outputs)[0]
            
        audio_np = audio_tensor.cpu().view(-1).numpy()
        wav_bytes = pcm_to_wav_bytes(audio_np, sample_rate=24000)
        elapsed = int((time.time() - t0) * 1000)
        print(f"[TTS] Generated {len(wav_bytes)} bytes in {elapsed}ms (VibeVoice)")
        return Response(wav_bytes, mimetype="audio/wav")

    except Exception as e:
        print(f"[TTS] VibeVoice error: {e}")
        return jsonify({"error": str(e)}), 500

def _tts_kokoro(text, voice):
    t0 = time.time()
    try:
        segments = []

        if _KOKORO_BACKEND == "mlx":
            # macOS: mlx_audio — GPU lock required (Metal not thread-safe)
            with _gpu_lock:
                for result in tts_model.generate(
                    text=text,
                    voice=voice,
                    speed=1.0,
                    lang_code="a",
                ):
                    segments.append(np.array(result.audio))
        else:
            # Windows / Linux: kokoro KPipeline
            for _, _, audio in tts_model(text, voice=voice, speed=1.0):
                segments.append(np.array(audio))

        if not segments:
            return jsonify({"error": "Kokoro generated no audio"}), 500

        audio = np.concatenate(segments)
        wav_bytes = pcm_to_wav_bytes(audio, sample_rate=24000)
        elapsed = int((time.time() - t0) * 1000)
        backend_label = f"Kokoro/{_KOKORO_BACKEND}"
        print(f"[TTS] Generated {len(wav_bytes)} bytes in {elapsed}ms ({backend_label}, voice={voice})")
        return Response(wav_bytes, mimetype="audio/wav")

    except Exception as e:
        print(f"[TTS] Kokoro error: {e}")
        return jsonify({"error": str(e)}), 500


def _tts_system(text):
    """Cross-platform system TTS.
    On macOS: prefers the native say/afconvert pipeline for best quality.
    Everywhere else (or on macOS fallback): uses pyttsx3 (Windows SAPI5 / espeak).
    """
    import platform
    wav_path = os.path.join(tempfile.gettempdir(), f"tts_{uuid.uuid4().hex}.wav")

    try:
        if platform.system() == "Darwin":
            aiff_path = wav_path.replace(".wav", ".aiff")
            try:
                subprocess.run(["say", "-o", aiff_path, text], check=True, timeout=10)
                subprocess.run(
                    ["afconvert", "-f", "WAVE", "-d", "LEI16", "-r", "22050", aiff_path, wav_path],
                    check=True, timeout=5,
                )
                with open(wav_path, 'rb') as f:
                    audio_data = f.read()
                print(f"[TTS] Generated {len(audio_data)} bytes (macOS say)")
                return Response(audio_data, mimetype="audio/wav")
            except Exception as e:
                print(f"[TTS] macOS say failed ({e}), falling back to pyttsx3")
            finally:
                if os.path.exists(aiff_path):
                    os.remove(aiff_path)

        # Cross-platform: pyttsx3
        import pyttsx3
        engine = pyttsx3.init()
        engine.save_to_file(text, wav_path)
        engine.runAndWait()
        engine.stop()

        if not os.path.exists(wav_path) or os.path.getsize(wav_path) == 0:
            return jsonify({"error": "pyttsx3 TTS produced no audio"}), 500

        with open(wav_path, 'rb') as f:
            audio_data = f.read()

        print(f"[TTS] Generated {len(audio_data)} bytes (pyttsx3)")
        return Response(audio_data, mimetype="audio/wav")

    except Exception as e:
        print(f"[TTS] System error: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if os.path.exists(wav_path):
            os.remove(wav_path)


@sock.route('/tts/stream')
def tts_stream(ws):
    import json
    import base64
    import traceback
    
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
                m, p = tts_model
                
                import torch
                prefilled_outputs = torch.load("demo/voices/sp-Spk1_man.pt", map_location=m.device if hasattr(m, 'device') else 'cpu', weights_only=False)
                inputs = p.process_input_with_cached_prompt(text=text, cached_prompt=prefilled_outputs, padding=True, return_tensors="pt", return_attention_mask=True)
                
                if hasattr(m, "device"):
                    inputs = {k: v.to(m.device) for k,v in inputs.items() if hasattr(v, "to")}
                from vibevoice.modular.streamer import AudioStreamer
                streamer = AudioStreamer(batch_size=1, timeout=12.0)
                
                def generate_task():
                    try:
                        m.generate(**inputs, streamer=streamer, tokenizer=p.tokenizer, all_prefilled_outputs=prefilled_outputs)
                    except Exception as e:
                        print(f"[VibeVoice] stream error: {e}")
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
                
            elif TTS_BACKEND == "kokoro":
                if _KOKORO_BACKEND == "mlx":
                    # macOS: mlx_audio — GPU lock required (Metal not thread-safe)
                    with _gpu_lock:
                        for result in tts_model.generate(text=text, voice=voice, speed=1.0, lang_code="a"):
                            audio_np = np.array(result.audio)
                            wav_bytes = pcm_to_wav_bytes(audio_np, sample_rate=24000)
                            ws.send(json.dumps({
                                "text": text,
                                "audio": base64.b64encode(wav_bytes).decode('ascii'),
                                "chunk": True
                            }))
                else:
                    # Windows / Linux: kokoro KPipeline
                    for _, _, audio in tts_model(text, voice=voice, speed=1.0):
                        audio_np = np.array(audio)
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

@app.route('/transcribe', methods=['POST'])
def transcribe():
    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files['audio']
    mime = (audio_file.mimetype or '').lower()
    filename = (audio_file.filename or '').lower()
    suffix = '.wav' if ('wav' in mime or filename.endswith('.wav')) else '.webm'

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        if STT_BACKEND == "mlx":
            return _transcribe_mlx(tmp_path)
        else:
            return _transcribe_faster_whisper(tmp_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def _transcribe_mlx(tmp_path):
    t0 = time.time()
    # For browser-segment WAV uploads we can transcribe directly.
    # For other containers (e.g. webm) convert to a separate temp WAV first.
    is_wav_input = tmp_path.lower().endswith('.wav')
    wav_path = tmp_path if is_wav_input else tmp_path.rsplit('.', 1)[0] + '.stt.wav'
    try:
        if not is_wav_input:
            subprocess.run(
                ["ffmpeg", "-y", "-i", tmp_path, "-ar", "16000", "-ac", "1", wav_path],
                check=True, timeout=10, capture_output=True,
            )
        with _gpu_lock:
            result = stt_model.transcribe(wav_path, language="en")
        elapsed = int((time.time() - t0) * 1000)
        text = result.get("text", "").strip()
        print(f"[STT] Transcribed in {elapsed}ms (mlx): {text[:80]}")
        return jsonify({
            "text": text,
            "language": "en",
            "probability": 1.0,
        })
    except Exception as e:
        print(f"[STT] MLX transcription error: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if not is_wav_input and os.path.exists(wav_path):
            os.remove(wav_path)


def _transcribe_faster_whisper(tmp_path):
    t0 = time.time()
    segments, info = stt_model.transcribe(tmp_path, beam_size=1, language="en")
    text = " ".join([segment.text for segment in segments]).strip()
    elapsed = int((time.time() - t0) * 1000)
    print(f"[STT] Transcribed in {elapsed}ms (faster-whisper): {text[:80]}")
    return jsonify({
        "text": text,
        "language": info.language,
        "probability": info.language_probability,
    })


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "model": MODEL_SIZE,
        "stt_backend": STT_BACKEND,
        "tts_backend": TTS_BACKEND,
    })

if __name__ == '__main__':
    print(f"Starting Transcription Service on port 3001 (STT={STT_BACKEND}, TTS={TTS_BACKEND})...")
    app.run(port=3001)

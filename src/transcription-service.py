import os
import io
import struct
import tempfile
import time
import uuid
import subprocess
import numpy as np
from flask import Flask, request, jsonify, Response

app = Flask(__name__)

# Configuration
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
STT_BACKEND = os.environ.get("STT_BACKEND", "mlx")
TTS_BACKEND = os.environ.get("TTS_BACKEND", "kokoro")
KOKORO_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")

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
if TTS_BACKEND == "kokoro":
    from mlx_audio.tts.utils import load_model as load_tts_model

    print(f"[TTS] Loading Kokoro (voice={KOKORO_VOICE})...")
    try:
        tts_model = load_tts_model("mlx-community/Kokoro-82M-bf16")
        print(f"[TTS] Kokoro loaded successfully.")
    except Exception as e:
        print(f"[TTS] Error loading Kokoro: {e}")
        raise
else:
    print(f"[TTS] Using macOS system TTS (say)")


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

    if TTS_BACKEND == "kokoro":
        return _tts_kokoro(text, voice)
    else:
        return _tts_system(text)


def _tts_kokoro(text, voice):
    t0 = time.time()
    try:
        segments = []
        for result in tts_model.generate(
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
        print(f"[TTS] Generated {len(wav_bytes)} bytes in {elapsed}ms (Kokoro, voice={voice})")
        return Response(wav_bytes, mimetype="audio/wav")

    except Exception as e:
        print(f"[TTS] Kokoro error: {e}")
        return jsonify({"error": str(e)}), 500


def _tts_system(text):
    filename = f"tts_{uuid.uuid4().hex}"
    aiff_path = os.path.join(tempfile.gettempdir(), filename + ".aiff")
    wav_path = os.path.join(tempfile.gettempdir(), filename + ".wav")

    try:
        subprocess.run(["say", "-o", aiff_path, text], check=True, timeout=10)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", "-r", "22050", aiff_path, wav_path], check=True, timeout=5)

        if not os.path.exists(wav_path):
            return jsonify({"error": "TTS conversion failed"}), 500

        with open(wav_path, 'rb') as f:
            audio_data = f.read()

        print(f"[TTS] Generated {len(audio_data)} bytes (system)")
        return Response(audio_data, mimetype="audio/wav")

    except subprocess.CalledProcessError as e:
        print(f"[TTS] System process error: {e}")
        return jsonify({"error": "TTS generation failed"}), 500
    except Exception as e:
        print(f"[TTS] System error: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if os.path.exists(aiff_path):
            os.remove(aiff_path)
        if os.path.exists(wav_path):
            os.remove(wav_path)


@app.route('/transcribe', methods=['POST'])
def transcribe():
    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files['audio']

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
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
    # Convert webm to 16kHz mono wav for whisper
    wav_path = tmp_path.rsplit('.', 1)[0] + '.wav'
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_path, "-ar", "16000", "-ac", "1", wav_path],
            check=True, timeout=10, capture_output=True,
        )
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
        if os.path.exists(wav_path):
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

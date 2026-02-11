import os
import tempfile
import uuid
import subprocess
from flask import Flask, request, jsonify, Response
from faster_whisper import WhisperModel

app = Flask(__name__)

# Configuration
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
DEVICE = "cpu"
COMPUTE_TYPE = "int8"

print(f"Loading Whisper Model: {MODEL_SIZE} on {DEVICE}...")
try:
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    print("Model loaded successfully.")
except Exception as e:
    print(f"Error loading model: {e}")

@app.route('/tts', methods=['POST'])
def tts():
    data = request.json
    text = data.get('text', '')
    if not text:
        return jsonify({"error": "No text provided"}), 400

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

        print(f"TTS generated: {len(audio_data)} bytes")
        return Response(audio_data, mimetype="audio/wav")

    except subprocess.CalledProcessError as e:
        print(f"TTS Process Error: {e}")
        return jsonify({"error": "TTS generation failed"}), 500
    except Exception as e:
        print(f"TTS Error: {e}")
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
        segments, info = model.transcribe(tmp_path, beam_size=1, language="en")
        text = " ".join([segment.text for segment in segments]).strip()

        return jsonify({
            "text": text,
            "language": info.language,
            "probability": info.language_probability
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE})

if __name__ == '__main__':
    print("Starting Transcription Service on port 3001...")
    app.run(port=3001)

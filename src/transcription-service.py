import os
import tempfile
import threading
from flask import Flask, request, jsonify, Response
from faster_whisper import WhisperModel
import pyttsx3

app = Flask(__name__)

# Configuration
MODEL_SIZE = "small"  # 'tiny', 'base', 'small', 'medium', 'large'
DEVICE = "cpu"       # 'cuda' if GPU available, else 'cpu'
COMPUTE_TYPE = "int8" # 'float16' for GPU, 'int8' for CPU

# ... imports ...
import pyttsx3
import base64

# ... whisper init ...
print(f"Loading Whisper Model: {MODEL_SIZE} on {DEVICE}...")
try:
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    print("Model loaded successfully.")
except Exception as e:
    print(f"Error loading model: {e}")


# TTS Init
print("Initializing TTS...")
engine = pyttsx3.init()
# Configure voice if needed (optional)
# voices = engine.getProperty('voices')
# engine.setProperty('voice', voices[0].id) 
engine.setProperty('rate', 170) 

@app.route('/tts', methods=['POST'])
def tts():
    data = request.json
    text = data.get('text', '')
    if not text:
        return jsonify({"error": "No text provided"}), 400

    import uuid
    import subprocess
    import sys

    # Use UUID for unique filename
    filename = f"tts_{uuid.uuid4().hex}.wav"
    tmp_path = os.path.join(tempfile.gettempdir(), filename)
    
    # On macOS, using 'say' to generate AIF then 'afconvert' to WAV is most robust
    # This avoids all python-audio library binding issues
    
    aiff_path = tmp_path + ".aiff"
    wav_path = tmp_path
    
    try:
        # 1. Generate AIFF using say
        subprocess.run(["say", "-o", aiff_path, text], check=True, timeout=10)
        
        # 2. Convert AIFF to WAV (16-bit PCM, 22.05kHz or 44.1kHz)
        # afconvert -f WAVE -d LEI16 -r 22050 source dest
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", "-r", "22050", aiff_path, wav_path], check=True, timeout=5)
        
        if not os.path.exists(wav_path):
             return jsonify({"error": "TTS conversion failed"}), 500

        with open(wav_path, 'rb') as f:
            audio_data = f.read()

        print(f"TTS generated: {len(audio_data)} bytes")
        
        # Clean up
        if os.path.exists(aiff_path): os.remove(aiff_path)
        if os.path.exists(wav_path): os.remove(wav_path)
        
        from flask import Response
        return Response(audio_data, mimetype="audio/wav")

    except subprocess.CalledProcessError as e:
        print(f"TTS Process Error: {e}")
        return jsonify({"error": "TTS generation failed"}), 500
    except Exception as e:
        print(f"TTS Error: {e}")
        if os.path.exists(aiff_path): os.remove(aiff_path)
        if os.path.exists(wav_path): os.remove(wav_path)
        return jsonify({"error": str(e)}), 500
        os.remove(tmp_path)
        
        from flask import Response
        return Response(audio_data, mimetype="audio/wav")

    except subprocess.CalledProcessError as e:
        print(f"TTS Subprocess Error: {e}")
        return jsonify({"error": "TTS generation failed"}), 500
    except Exception as e:
        print(f"TTS Error: {e}")
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        return jsonify({"error": str(e)}), 500

@app.route('/transcribe', methods=['POST'])
def transcribe():
# ... unchanged ...
# ... rest of transcribe ...
    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files['audio']
    
    # Save to temp file because faster-whisper needs a file path or file-like object
    # (It can handle file-like objects but temp file is safer for format detection)
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(tmp_path, beam_size=5, language="en")
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

import os
import tempfile
import threading
from flask import Flask, request, jsonify, Response
from faster_whisper import WhisperModel
import pyttsx3

app = Flask(__name__)

# Configuration
MODEL_SIZE = "tiny"  # 'tiny', 'base', 'small', 'medium', 'large'
DEVICE = "cpu"       # 'cuda' if GPU available, else 'cpu'
COMPUTE_TYPE = "int8" # 'float16' for GPU, 'int8' for CPU

# ... imports ...
import pyttsx3
import base64

# ... whisper init ...

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

    # Save to temp file
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    
    # pyttsx3 saves to file asynchronously in its loop, but save_to_file is usually blocking enough for simple scripts
    # However, running the loop inside flask can be tricky.
    # We'll try a new engine instance per request or use the global one carefully.
    # Ideally, we run the loop.
    
    try:
        # Re-init engine per request to avoid loop issues in threaded flask? 
        # Actually pyttsx3 is not thread safe. 
        # For a simple sidecar, we might need a lock or just a fresh instance.
        # Let's try running it simply first.
        
        # Determine unique file path
        
        engine.save_to_file(text, tmp_path)
        engine.runAndWait()
        
        # Read file
        with open(tmp_path, 'rb') as f:
            audio_data = f.read()
            
        # Return as base64 or binary? 
        # Binary is better.
        
        # Clean up
        os.remove(tmp_path)
        
        from flask import Response
        return Response(audio_data, mimetype="audio/wav")
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/transcribe', methods=['POST'])
def transcribe():
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
        segments, info = model.transcribe(tmp_path, beam_size=5)
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

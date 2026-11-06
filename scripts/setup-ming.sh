#!/usr/bin/env bash
# Sets up venv-ming for the Ming TTS service (src/ming-tts-service.py): the cloned voices.
# It is separate from venv because mlx-audio 0.6.4 needs a newer mlx than speech-to-text.
# Apple Silicon only (MLX). Once it exists, the Tubs server starts the service by itself.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$PROJECT_DIR/venv-ming"
REQ_FILE="$PROJECT_DIR/requirements-ming.txt"
VOICE_DIR="${MING_VOICE_DIR:-$PROJECT_DIR/data/ming-voices}"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    echo "[setup-ming] Ming runs on MLX, Apple Silicon only. Skipped."
    exit 0
fi

if ! command -v python3.11 &>/dev/null; then
    echo "[setup-ming] ERROR: Python 3.11 required (the voice was tuned with it). Install with: brew install python@3.11"
    exit 1
fi

if [ ! -f "$VENV_DIR/bin/python" ]; then
    echo "[setup-ming] Creating venv-ming..."
    python3.11 -m venv "$VENV_DIR"
fi

STAMP="$VENV_DIR/.deps-installed"
if [ ! -f "$STAMP" ] || [ "$REQ_FILE" -nt "$STAMP" ] || [ "$0" -nt "$STAMP" ]; then
    echo "[setup-ming] Installing Ming dependencies..."
    "$VENV_DIR/bin/pip" install -q -r "$REQ_FILE"
    touch "$STAMP"
else
    echo "[setup-ming] Dependencies up to date."
fi

# The service runs offline, so the model has to be in the Hugging Face cache first.
echo "[setup-ming] Fetching mlx-community/Ming-3.0-tts-0.5B-bf16 into the Hugging Face cache (once)..."
"$VENV_DIR/bin/python" -c "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/Ming-3.0-tts-0.5B-bf16')" >/dev/null

missing=0
for ref in ref_rec_full ref_B_full_dn ref_B_alt_full_dn; do
    for f in "$ref.wav" "$ref.txt" "spk_emb_$ref.npy"; do
        [ -f "$VOICE_DIR/$f" ] || { echo "[setup-ming] missing voice file: $VOICE_DIR/$f"; missing=1; }
    done
done
if [ "$missing" -eq 1 ]; then
    echo "[setup-ming] The voice references are not in git (recordings of a real person)."
    echo "             Copy them into $VOICE_DIR; ~/Movies/tubs-voice-lab/README.md says where they come from."
    exit 1
fi
echo "[setup-ming] Ready. The Tubs server starts the Ming service on port ${MING_PORT:-3003}."

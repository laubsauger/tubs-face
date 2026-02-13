#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$PROJECT_DIR/venv"
REQ_FILE="$PROJECT_DIR/requirements.txt"

# MLX/spacy/misaki wheels only exist for 3.11 and 3.12.
# Prefer 3.11 (tested), accept 3.12, reject anything else.
PYTHON=""
for candidate in python3.11 python3.12; do
    if command -v "$candidate" &>/dev/null; then
        PYTHON="$candidate"
        break
    fi
done

# Fallback: check if generic python3 is a compatible version
if [ -z "$PYTHON" ] && command -v python3 &>/dev/null; then
    PY_MINOR=$(python3 -c 'import sys; print(sys.version_info.minor)')
    if [ "$PY_MINOR" = "11" ] || [ "$PY_MINOR" = "12" ]; then
        PYTHON="python3"
    fi
fi

if [ -z "$PYTHON" ]; then
    echo ""
    echo "============================================================"
    echo "[setup-python] ERROR: Python 3.11 or 3.12 required."
    echo ""
    echo "  Your system python3 is too new (or missing)."
    echo "  MLX and spacy packages need 3.11 or 3.12."
    echo ""
    echo "  Install with:  brew install python@3.11"
    echo "============================================================"
    echo ""
    exit 1
fi

PY_VERSION=$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "[setup-python] Using $PYTHON ($PY_VERSION)"

# If venv exists but was created with a different Python, recreate it
if [ -f "$VENV_DIR/bin/python" ]; then
    VENV_PY=$("$VENV_DIR/bin/python" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "unknown")
    if [ "$VENV_PY" != "$PY_VERSION" ]; then
        echo "[setup-python] Venv has Python $VENV_PY but need $PY_VERSION — recreating..."
        rm -rf "$VENV_DIR"
    fi
fi

# Create venv if missing
if [ ! -f "$VENV_DIR/bin/python" ]; then
    echo "[setup-python] Creating venv..."
    "$PYTHON" -m venv "$VENV_DIR"
fi

# Install/update deps if requirements.txt is newer than the stamp file
STAMP="$VENV_DIR/.deps-installed"
if [ ! -f "$STAMP" ] || [ "$REQ_FILE" -nt "$STAMP" ]; then
    echo "[setup-python] Installing Python dependencies..."
    "$VENV_DIR/bin/pip" install --upgrade pip -q
    "$VENV_DIR/bin/pip" install -r "$REQ_FILE"
    touch "$STAMP"
else
    echo "[setup-python] Python dependencies up to date."
fi

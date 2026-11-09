"""Face service for Tubs: the studio camera's faces, found and embedded on the server (docs/face-service.md).

The Tubs server starts it from the speech service's venv (numpy, onnxruntime, Pillow:
requirements-faces.txt) when FACE_SERVICE=local, or it runs on another box (FACE_SERVICE=<url>,
fleet:faces). It reads one camera (an RTSP stream through ffmpeg, or a snapshot URL), finds the
faces (SCRFD det_10g), aligns and embeds them (ArcFace w600k_r50) exactly as the browser worker
does (src/face_pipeline.py), and tracks them across frames. Matching against the face library
happens on the Tubs server, which keeps the library.

Start by hand:  venv/bin/python -I src/face-service.py [--port 3004] [--host 127.0.0.1]
HTTP (stdlib ThreadingHTTPServer):
  GET  /health        -> {state: loading|ready|error, backend, threads, error?, download?, source, fps, inferMs, frames, where}
  POST /source        {"url": "rtsp://..." | "http(s)://...jpg" | null, "fps": 5, "label": "site:cam-1"} -> {ok}
  GET  /observations  -> application/x-ndjson, one line per frame checked (and one a second while idle):
                         {t, source, frame: {w, h}, faces: [{track, box: [x1, y1, x2, y2] px, score,
                         landmarks, embedding: [512] | null}], status: <as /health>}
  GET  /frame.jpg?max=512   the newest frame, longest side at most max (404 without one)
  GET  /thumbnail?track=N   that track's face from the frame it was last seen in, as the library keeps it
  POST /capture       -> {faces: [{box, score, embedding, thumbnail}], frame: {w, h}} from the next frame checked
  POST /detect        an image (PNG or JPEG body) -> {faces: [{box, score, landmarks, embedding, thumbnail}], frame: {w, h}}
Models: downloaded once into FACE_MODEL_DIR (default ~/.cache/tubs-face/models), from the URLs the
browser worker uses. FACE_SERVICE_BACKEND: auto (CoreML on a Mac, CUDA if onnxruntime has it, else
CPU), coreml, cuda or cpu. Never logs a camera URL's login.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import platform
import queue
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import face_pipeline  # noqa: E402  (src/, next to this file)

MODELS = {
    "det_10g.onnx": {
        "url": "https://huggingface.co/public-data/insightface/resolve/main/models/buffalo_l/det_10g.onnx",
        "sha256": "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
    },
    "w600k_r50.onnx": {
        "url": "https://huggingface.co/public-data/insightface/resolve/main/models/buffalo_l/w600k_r50.onnx",
        "sha256": "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
    },
}
MODEL_DIR = os.path.expanduser(os.environ.get("FACE_MODEL_DIR") or "~/.cache/tubs-face/models")
MAX_FRAME_WIDTH = 960  # what the browser worker gets (client/face/runtime.ts)
DOWNLOAD_RETRY_S = 30
CAMERA_RETRY_S = 3
IDLE_LINE_S = 1.0
FPS_WINDOW_S = 5.0


def log(message):
    print(f"[faces] {message}", flush=True)


def safe_url(url):
    """A URL without its login, for logs and /health."""
    if not url:
        return url
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    netloc = f"{host}:{parts.port}" if parts.port else host
    return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, "", ""))


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = "loading"
        self.error = None
        self.download = None
        self.backend = None
        self.threads = None
        self.pipeline = None
        self.source_url = None
        self.source_label = None
        self.source_error = None
        self.fps_target = 5.0
        self.frame = None  # newest decoded frame (RGB uint8), with its time
        self.frame_at = 0.0
        self.frame_seq = 0
        self.checked = []  # times of frames checked, for fps
        self.infer_ms = 0.0
        self.frames = 0
        self.last_faces = []  # [{track, box, frame_rgb}]
        self.subscribers = set()
        self.capture_waiters = []
        self.new_frame = threading.Condition(self.lock)

    def health(self):
        now = time.time()
        recent = [t for t in self.checked if now - t <= FPS_WINDOW_S]
        fps = len(recent) / FPS_WINDOW_S if recent else 0.0
        state = self.state
        error = self.error
        if state == "ready" and self.source_url and self.source_error:
            error = self.source_error
        out = {
            "state": state,
            "backend": self.backend or "",
            "fps": round(fps, 2),
            "inferMs": round(self.infer_ms, 1),
            "frames": self.frames,
            "source": self.source_label,
            "camera": None if not self.source_url else ("ok" if not self.source_error and now - self.frame_at < 5 else "no frames"),
            "where": socket.gethostname().removesuffix(".local"),
        }
        if self.threads:
            out["threads"] = self.threads
        if error:
            out["error"] = error
        if self.download:
            out["download"] = self.download
        return out


S = State()


# ---------- models ----------

def fetch_model(name, spec):
    path = os.path.join(MODEL_DIR, name)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(MODEL_DIR, exist_ok=True)
    part = path + ".part"
    log(f"downloading {name} from {spec['url']} into {MODEL_DIR}")
    request = urllib.request.Request(spec["url"], headers={"User-Agent": "tubs-face-service"})
    digest = hashlib.sha256()
    with urllib.request.urlopen(request, timeout=30) as response, open(part, "wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        last_logged = -10
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            digest.update(chunk)
            done += len(chunk)
            pct = round(done * 100 / total) if total else None
            with S.lock:
                S.download = {"file": name, "pct": pct, "mb": round(done / 1e6, 1), "totalMb": round(total / 1e6, 1) if total else None}
            if pct is not None and pct - last_logged >= 10:
                last_logged = pct
                log(f"{name}: {pct}% ({done / 1e6:.1f} of {total / 1e6:.1f} MB)")
    if total and done != total:
        raise IOError(f"{name}: got {done} of {total} bytes")
    if spec["sha256"] and digest.hexdigest() != spec["sha256"]:
        os.remove(part)
        raise IOError(f"{name}: checksum mismatch (got {digest.hexdigest()[:12]}...)")
    os.replace(part, path)
    log(f"{name}: downloaded ({done / 1e6:.1f} MB)")
    return path


# CoreML as an ML program on the GPU, in FP32. Its default (a neural network, on the Neural
# Engine) computes in FP16: cosine to the browser's embeddings down to 0.995 instead of 0.99998
# (tests/face-compat/run.ts), for 11 instead of 16 ms per face.
COREML_OPTIONS = {"ModelFormat": "MLProgram", "MLComputeUnits": "CPUAndGPU"}


def pick_backend(available):
    wanted = (os.environ.get("FACE_SERVICE_BACKEND") or "auto").strip().lower()
    if wanted == "coreml" or (wanted == "auto" and sys.platform == "darwin" and "CoreMLExecutionProvider" in available):
        return "CoreML", [("CoreMLExecutionProvider", COREML_OPTIONS), "CPUExecutionProvider"]
    if wanted == "cuda" or (wanted == "auto" and "CUDAExecutionProvider" in available):
        return "CUDA", ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return "CPU", ["CPUExecutionProvider"]


def drop_coreml_noise():
    """
    CoreML prints "E5RT encountered an STL exception ... unbounded dimension" on stdout for the
    detector's free input size, now and then and at exit (it runs the model anyway). stdout goes
    through a pipe that drops those lines and passes everything else on.
    """
    sys.stdout.flush()
    read_fd, write_fd = os.pipe()
    original = os.dup(1)
    os.dup2(write_fd, 1)
    os.close(write_fd)

    def pump():
        with os.fdopen(read_fd, "rb") as pipe:
            for raw in pipe:
                text = raw.decode("utf-8", "replace").replace("..E5RT", ".\nE5RT")
                kept = "".join(part for part in text.splitlines(keepends=True) if "E5RT encountered" not in part)
                if kept.strip():
                    os.write(original, kept.encode("utf-8"))

    threading.Thread(target=pump, daemon=True).start()


def load_models():
    while True:
        try:
            paths = {name: fetch_model(name, spec) for name, spec in MODELS.items()}
            break
        except Exception as error:  # noqa: BLE001 - shown in /health, retried
            reason = f"could not download the face models from huggingface.co ({error}); retrying in {DOWNLOAD_RETRY_S} s"
            log(reason)
            with S.lock:
                S.state, S.error, S.download = "error", reason, None
            time.sleep(DOWNLOAD_RETRY_S)
            with S.lock:
                S.state, S.error = "loading", None
    with S.lock:
        S.download = None
    import onnxruntime as ort

    ort.set_default_logger_severity(3)  # errors only: CoreML warns about every op it leaves to the CPU
    backend, providers = pick_backend(ort.get_available_providers())
    threads = max(1, min(4, (os.cpu_count() or 2) - 2))
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.log_severity_level = 3
    try:
        det = ort.InferenceSession(paths["det_10g.onnx"], options, providers=providers)
        rec = ort.InferenceSession(paths["w600k_r50.onnx"], options, providers=providers)
        pipeline = face_pipeline.Pipeline(det, rec)
        # One run each, so the first camera frame is not the slow one (CoreML compiles here).
        pipeline.detect(np.zeros((360, 640, 3), dtype=np.uint8))
        pipeline.rec.run(None, {pipeline.rec_input: np.zeros((1, 3, 112, 112), dtype=np.float32)})
    except Exception as error:  # noqa: BLE001
        reason = f"could not load the face models with {backend}: {error}"
        log(reason)
        with S.lock:
            S.state, S.error = "error", reason
        return
    actual = det.get_providers()[0]
    if backend != "CPU" and actual == "CPUExecutionProvider":
        backend = "CPU"
    with S.lock:
        S.pipeline, S.backend, S.threads, S.state, S.error = pipeline, backend, threads, "ready", None
    log(f"ready: SCRFD det_10g + ArcFace w600k_r50 on {backend} ({threads} threads)")


# ---------- camera ----------

def fit_width(width, height):
    if width <= MAX_FRAME_WIDTH:
        return width, height
    scale = MAX_FRAME_WIDTH / width
    return MAX_FRAME_WIDTH, max(2, face_pipeline.round_half_up(height * scale / 2) * 2)


def probe_size(url):
    command = ["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0",
               "-show_entries", "stream=width,height", "-of", "json", url]
    result = subprocess.run(command, capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        message = (result.stderr or "").strip().splitlines()
        raise IOError(message[-1] if message else f"ffprobe exited {result.returncode}")
    streams = json.loads(result.stdout or "{}").get("streams") or []
    if not streams:
        raise IOError("the stream has no video")
    return int(streams[0]["width"]), int(streams[0]["height"])


def publish_frame(rgb):
    with S.lock:
        S.frame = rgb
        S.frame_at = time.time()
        S.frame_seq += 1
        S.source_error = None
        S.new_frame.notify_all()


def note_camera_error(url, message):
    message = message.replace(url, safe_url(url)) if url else message
    with S.lock:
        if S.source_url == url:
            if S.source_error != message:
                log(f"camera {safe_url(url)}: {message}")
            S.source_error = message[:300]


def read_rtsp(url, generation):
    while current_generation() == generation:
        process = None
        try:
            width, height = probe_size(url)
            out_w, out_h = fit_width(width, height)
            fps = S.fps_target
            command = ["ffmpeg", "-nostdin", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", url,
                       "-an", "-sn", "-vf", f"fps={fps},scale={out_w}:{out_h}:flags=bilinear",
                       "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            frame_bytes = out_w * out_h * 3
            log(f"camera {safe_url(url)}: {width}x{height}, checked at {out_w}x{out_h}, {fps:g} fps")
            while current_generation() == generation:
                data = process.stdout.read(frame_bytes)
                if len(data) < frame_bytes:
                    break
                publish_frame(np.frombuffer(data, dtype=np.uint8).reshape(out_h, out_w, 3))
            if current_generation() == generation:
                err = (process.stderr.read() or b"").decode("utf-8", "replace").strip().splitlines()
                note_camera_error(url, err[-1] if err else "the stream ended")
        except Exception as error:  # noqa: BLE001
            note_camera_error(url, str(error))
        finally:
            if process and process.poll() is None:
                process.kill()
                process.wait()
        if current_generation() == generation:
            time.sleep(CAMERA_RETRY_S)


def read_snapshots(url, generation):
    while current_generation() == generation:
        started = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"Cache-Control": "no-store"}), timeout=4) as response:
                image = Image.open(io.BytesIO(response.read())).convert("RGB")
            width, height = image.size
            out_w, out_h = fit_width(width, height)
            if (out_w, out_h) != (width, height):
                image = image.resize((out_w, out_h), Image.BILINEAR)
            publish_frame(np.asarray(image, dtype=np.uint8))
        except Exception as error:  # noqa: BLE001
            note_camera_error(url, str(error))
            time.sleep(CAMERA_RETRY_S)
        time.sleep(max(0.0, 1.0 / S.fps_target - (time.time() - started)))


_generation = [0]


def current_generation():
    return _generation[0]


def set_source(url, label, fps):
    with S.lock:
        _generation[0] += 1
        generation = _generation[0]
        S.source_url = url
        S.source_label = label if url else None
        S.source_error = None
        S.fps_target = max(0.5, min(15.0, float(fps or 5)))
        S.frame = None
        S.last_faces = []
    if not url:
        log("camera off")
        return
    reader = read_rtsp if url.startswith("rtsp://") or url.startswith("rtsps://") else read_snapshots
    threading.Thread(target=reader, args=(url, generation), daemon=True).start()


# ---------- the loop ----------

def check_frame(pipeline, rgb, tracker, now):
    started = time.perf_counter()
    faces = pipeline.detect(rgb)
    tracker.assign(faces, now)
    for face in faces:
        if face.get("reuse") is not None:
            face["embedding"] = face["reuse"]
        elif face.get("landmarks"):
            face["embedding"] = pipeline.embed(rgb, face["landmarks"])
        else:
            face["embedding"] = None
    tracker.remember(faces, now)
    return faces, (time.perf_counter() - started) * 1000


def face_out(face, with_landmarks=True):
    out = {
        "track": face.get("track"),
        "box": [round(v, 2) for v in face["box"]],
        "score": round(face["score"], 4),
        "embedding": None if face.get("embedding") is None else [round(float(v), 6) for v in face["embedding"]],
    }
    if with_landmarks:
        out["landmarks"] = face.get("landmarks") and [[round(x, 2), round(y, 2)] for x, y in face["landmarks"]]
    return out


def broadcast(line):
    with S.lock:
        subscribers = list(S.subscribers)
    for subscriber in subscribers:
        try:
            subscriber.put_nowait(line)
        except queue.Full:
            pass  # a slow reader misses frames, never holds the loop


def loop():
    tracker = face_pipeline.Tracker(reuse_s=1.0)
    seen_seq = 0
    last_line = 0.0
    while True:
        with S.lock:
            S.new_frame.wait(timeout=IDLE_LINE_S)
            pipeline = S.pipeline
            fresh = S.frame is not None and S.frame_seq != seen_seq and pipeline is not None
            rgb, frame_at, seen = (S.frame, S.frame_at, S.frame_seq) if fresh else (None, 0.0, seen_seq)
            label = S.source_label
        if not fresh:
            if time.time() - last_line >= IDLE_LINE_S:
                last_line = time.time()
                with S.lock:
                    status = S.health()
                broadcast(json.dumps({"t": int(time.time() * 1000), "source": label, "frame": None, "faces": [], "status": status}))
            continue
        seen_seq = seen
        now = time.time()
        try:
            faces, ms = check_frame(pipeline, rgb, tracker, now)
        except Exception as error:  # noqa: BLE001
            log(f"frame failed: {error}")
            with S.lock:
                S.source_error = f"frame failed: {error}"[:300]
            continue
        with S.lock:
            S.infer_ms = ms
            S.frames += 1
            S.checked = [t for t in S.checked if now - t <= FPS_WINDOW_S] + [now]
            S.last_faces = [{"track": f["track"], "box": f["box"], "frame": rgb} for f in faces]
            waiters, S.capture_waiters = S.capture_waiters, []
            status = S.health()
        for waiter in waiters:
            waiter.put((rgb, faces))
        h, w = rgb.shape[:2]
        last_line = time.time()
        broadcast(json.dumps({
            "t": int(frame_at * 1000), "source": label, "frame": {"w": w, "h": h},
            "faces": [face_out(f) for f in faces], "status": status,
        }))


# ---------- pictures ----------

def jpeg(rgb, quality):
    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, format="JPEG", quality=quality)
    return buffer.getvalue()


def thumbnail(rgb, box):
    """The face as the library keeps it: padded by 18 % (12 px at least), 112 px on its longest side (enrollment.ts)."""
    height, width = rgb.shape[:2]
    x1, y1, x2, y2 = box
    pad_x = max(12, face_pipeline.round_half_up((x2 - x1) * 0.18))
    pad_y = max(12, face_pipeline.round_half_up((y2 - y1) * 0.18))
    sx = max(0, face_pipeline.round_half_up(x1 - pad_x))
    sy = max(0, face_pipeline.round_half_up(y1 - pad_y))
    sw = min(width - sx, face_pipeline.round_half_up((x2 - x1) + pad_x * 2))
    sh = min(height - sy, face_pipeline.round_half_up((y2 - y1) + pad_y * 2))
    if sw <= 0 or sh <= 0:
        return None
    scale = 112 / max(1, max(sw, sh))
    out_w = max(72, face_pipeline.round_half_up(sw * scale))
    out_h = max(72, face_pipeline.round_half_up(sh * scale))
    crop = Image.fromarray(rgb[sy:sy + sh, sx:sx + sw]).resize((out_w, out_h), Image.BILINEAR)
    return "data:image/jpeg;base64," + base64.b64encode(jpeg(np.asarray(crop), 76)).decode("ascii")


def scaled(rgb, max_px):
    height, width = rgb.shape[:2]
    scale = min(1.0, max_px / max(width, height))
    if scale >= 1.0:
        return rgb
    size = (max(1, face_pipeline.round_half_up(width * scale)), max(1, face_pipeline.round_half_up(height * scale)))
    return np.asarray(Image.fromarray(rgb).resize(size, Image.BILINEAR))


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quiet: the stream would fill the log
        pass

    def send_json(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self, limit=20 << 20):
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise ValueError("body too large")
        return self.rfile.read(length) if length else b""

    def do_GET(self):  # noqa: N802
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        if url.path == "/health":
            with S.lock:
                self.send_json(200, S.health())
            return
        if url.path == "/observations":
            self.stream()
            return
        if url.path == "/frame.jpg":
            with S.lock:
                rgb = S.frame
            if rgb is None:
                self.send_json(404, {"error": "no frame"})
                return
            max_px = int((query.get("max") or ["512"])[0])
            data = jpeg(scaled(rgb, max(16, min(4096, max_px))), 70)
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        if url.path == "/thumbnail":
            try:
                track = int((query.get("track") or [""])[0])
            except ValueError:
                self.send_json(400, {"error": "track must be a number"})
                return
            with S.lock:
                face = next((f for f in S.last_faces if f["track"] == track), None)
            picture = face and thumbnail(face["frame"], face["box"])
            self.send_json(200 if picture else 404, {"thumbnail": picture} if picture else {"error": "no such face in the last frame"})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        try:
            raw = self.body()
            if path == "/source":
                body = json.loads(raw or b"{}")
                url = body.get("url")
                if url is not None and not (isinstance(url, str) and url.split("://")[0] in ("rtsp", "rtsps", "http", "https")):
                    self.send_json(400, {"error": "url must be rtsp://, http(s):// or null"})
                    return
                set_source(url, body.get("label") or (safe_url(url) if url else None), body.get("fps") or 5)
                self.send_json(200, {"ok": True})
                return
            if path == "/capture":
                self.capture(json.loads(raw or b"{}"))
                return
            if path == "/detect":
                self.detect(raw)
                return
        except Exception as error:  # noqa: BLE001
            self.send_json(400, {"error": str(error)[:300]})
            return
        self.send_json(404, {"error": "not found"})

    def detect(self, raw):
        with S.lock:
            pipeline = S.pipeline
        if pipeline is None:
            self.send_json(503, {"error": "the face models are still loading"})
            return
        rgb = np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.uint8)
        faces = pipeline.detect(rgb)
        for face in faces:
            face["embedding"] = pipeline.embed(rgb, face["landmarks"]) if face.get("landmarks") else None
        out = [face_out(f) for f in faces]
        # With each face's thumbnail, as /capture: an upload for someone's samples (embedPicture) keeps it.
        for item, face in zip(out, faces):
            item["thumbnail"] = thumbnail(rgb, face["box"]) if face.get("embedding") is not None else None
        self.send_json(200, {"frame": {"w": rgb.shape[1], "h": rgb.shape[0]}, "faces": out})

    def capture(self, body):
        """The faces of the next frame checked, each embedded afresh, with its thumbnail (onboarding)."""
        with S.lock:
            pipeline = S.pipeline
            if pipeline is None or not S.source_url:
                self.send_json(503, {"error": "the face models are still loading" if pipeline is None else "no camera"})
                return
            waiter = queue.Queue(maxsize=1)
            S.capture_waiters.append(waiter)
        try:
            rgb, faces = waiter.get(timeout=float(body.get("timeoutS") or 3))
        except queue.Empty:
            self.send_json(504, {"error": "no frame from the camera"})
            return
        out = []
        for face in faces:
            embedding = pipeline.embed(rgb, face["landmarks"]) if face.get("landmarks") else None
            if embedding is None:
                continue
            item = face_out({**face, "embedding": embedding}, with_landmarks=False)
            item["thumbnail"] = thumbnail(rgb, face["box"])
            out.append(item)
        self.send_json(200, {"frame": {"w": rgb.shape[1], "h": rgb.shape[0]}, "faces": out})

    def stream(self):
        subscriber = queue.Queue(maxsize=8)
        with S.lock:
            S.subscribers.add(subscriber)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            while True:
                line = subscriber.get()
                self.wfile.write(line.encode("utf-8") + b"\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with S.lock:
                S.subscribers.discard(subscriber)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # A client that went away mid-answer (a health probe that timed out) is not an error.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=int(os.environ.get("FACE_SERVICE_PORT", "3004")))
    parser.add_argument("--host", default=os.environ.get("FACE_SERVICE_HOST", "127.0.0.1"))
    args = parser.parse_args()
    if sys.platform == "darwin":
        drop_coreml_noise()
    server = Server((args.host, args.port), Handler)
    log(f"listening on http://{args.host}:{args.port} ({platform.machine()}, models in {MODEL_DIR})")
    threading.Thread(target=load_models, daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

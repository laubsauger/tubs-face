"""Record what the face service would stream for a video, without a camera or a server: each
frame through the service's own check (src/face-service.py check_frame: detection, tracking,
an embedding a second per track) at the service's 5 fps, written as its NDJSON lines (with
embeddings and the fresh flag) for src/scripts/face-name-replay.ts.

  venv/bin/python -I tests/face-compat/record_lines.py <video> <out.ndjson> [--fps 5] [--seconds 10]
"""
import argparse
import importlib.util
import json
import os
import subprocess
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src"))
spec = importlib.util.spec_from_file_location("face_service", os.path.join(ROOT, "src", "face-service.py"))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
import face_pipeline  # noqa: E402
import onnxruntime as ort  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("video")
parser.add_argument("out")
parser.add_argument("--fps", type=float, default=5)
parser.add_argument("--seconds", type=float, default=10)
args = parser.parse_args()

options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.log_severity_level = 3
pipeline = face_pipeline.Pipeline(
    ort.InferenceSession(os.path.join(service.MODEL_DIR, "det_10g.onnx"), options, providers=["CPUExecutionProvider"]),
    ort.InferenceSession(os.path.join(service.MODEL_DIR, "w600k_r50.onnx"), options, providers=["CPUExecutionProvider"]),
)
probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", args.video],
                                  capture_output=True, text=True, check=True).stdout)["streams"][0]
out_w, out_h = service.fit_width(int(probe["width"]), int(probe["height"]))
decoder = subprocess.Popen(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", args.video, "-t", str(args.seconds), "-an",
                            "-vf", f"fps={args.fps},scale={out_w}:{out_h}:flags=bilinear", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                           stdout=subprocess.PIPE)
tracker = face_pipeline.Tracker(reuse_s=1.0)
count = 0
with open(args.out, "w") as out:
    while True:
        data = decoder.stdout.read(out_w * out_h * 3)
        if len(data) < out_w * out_h * 3:
            break
        at = count / args.fps
        rgb = np.frombuffer(data, dtype=np.uint8).reshape(out_h, out_w, 3)
        faces, ms = service.check_frame(pipeline, rgb, tracker, at)
        out.write(json.dumps({"t": int(at * 1000), "source": os.path.basename(args.video), "frame": {"w": out_w, "h": out_h},
                              "faces": [service.face_out(face, with_landmarks=False) for face in faces]}) + "\n")
        count += 1
decoder.wait()
print(f"{count} frames -> {args.out}")

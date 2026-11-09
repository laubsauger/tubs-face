"""The face pipeline of the face service (src/face-service.py, docs/face-service.md).

SCRFD det_10g finds the faces and their five landmarks; each face is aligned to
112x112 and ArcFace w600k_r50 turns it into an embedding. Every step copies the
browser worker (src/workers/face-worker.ts) exactly, not insightface's own
python code, because the face library's embeddings came from the browser:

  - the pictures go into both models in B, G, R channel order (the worker reads
    an RGBA canvas into the planes as [2], [1], [0]); insightface feeds R, G, B;
  - anchor centres sit at (col + 0.5) * stride; insightface puts them at col * stride,
    so every box and landmark of the worker is half a stride further right and down;
  - the picture is centred in the 640x640 detector input (insightface pads at the
    bottom right);
  - resampling is what Chrome's canvas does with image smoothing on: bilinear,
    pixel centres at +0.5, no mipmaps, the result rounded to 8 bits; outside the
    drawn picture is black;
  - the similarity transform for the alignment is the worker's own Umeyama with
    its closed-form 2x2 SVD.

Pure numpy and onnxruntime, no OpenCV: the resampling has to match Chrome's.
"""
import math

import numpy as np

INPUT_SIZE = 640
STRIDES = (8, 16, 32)
NMS_THRESH = 0.4
CONF_THRESH = 0.5
EMBED_SIZE = 112

ARCFACE_TEMPLATE = np.array([
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
], dtype=np.float64)


def _anchors():
    out = []
    for stride in STRIDES:
        grid = math.ceil(INPUT_SIZE / stride)
        rows, cols = np.mgrid[0:grid, 0:grid]
        centres = np.stack([(cols + 0.5) * stride, (rows + 0.5) * stride], axis=-1).reshape(-1, 2)
        out.append(np.repeat(centres, 2, axis=0).astype(np.float64))  # two anchors per place
    return out


ANCHORS = _anchors()


def _round8(values):
    return np.clip(np.floor(values + 0.5), 0, 255).astype(np.uint8)


def _axis_taps(size_out, offset, scale, size_in):
    """Bilinear taps along one axis for dst pixels 0..size_out-1 drawn at offset with scale (dst px per src px)."""
    centres = (np.arange(size_out, dtype=np.float64) + 0.5 - offset) / scale  # src coords, pixel edges at integers
    inside = (centres >= 0) & (centres < size_in)
    pos = centres - 0.5
    lo = np.floor(pos)
    frac = (pos - lo).astype(np.float32)
    i0 = np.clip(lo, 0, size_in - 1).astype(np.int64)
    i1 = np.clip(lo + 1, 0, size_in - 1).astype(np.int64)
    return i0, i1, frac, inside


def draw_scaled(src, out_w, out_h, dx, dy, dw, dh):
    """Canvas drawImage(src, dx, dy, dw, dh) onto a black out_w x out_h canvas (uint8 RGB)."""
    h, w = src.shape[:2]
    x0, x1, fx, xin = _axis_taps(out_w, dx, dw / w, w)
    y0, y1, fy, yin = _axis_taps(out_h, dy, dh / h, h)
    img = src.astype(np.float32)
    cols = img[:, x0] * (1 - fx)[None, :, None] + img[:, x1] * fx[None, :, None]
    rows = cols[y0] * (1 - fy)[:, None, None] + cols[y1] * fy[:, None, None]
    out = _round8(rows)
    out[~yin] = 0
    out[:, ~xin] = 0
    return out


def detector_input(rgb):
    """The 1x3x640x640 detector tensor (B, G, R planes), and how the picture was placed: (scale, pad_x, pad_y)."""
    h, w = rgb.shape[:2]
    scale = min(INPUT_SIZE / w, INPUT_SIZE / h)
    scaled_w = round_half_up(w * scale)
    scaled_h = round_half_up(h * scale)
    pad_x = round_half_up((INPUT_SIZE - scaled_w) / 2)
    pad_y = round_half_up((INPUT_SIZE - scaled_h) / 2)
    canvas = draw_scaled(rgb, INPUT_SIZE, INPUT_SIZE, pad_x, pad_y, scaled_w, scaled_h)
    planes = canvas[:, :, ::-1].transpose(2, 0, 1).astype(np.float32)
    tensor = ((planes - 127.5) / 128.0)[None]
    return np.ascontiguousarray(tensor), (scale, pad_x, pad_y)


def round_half_up(value):
    """JavaScript's Math.round."""
    return int(math.floor(value + 0.5))


def decode_detections(outputs, placement):
    """Model outputs -> faces [{box: [x1, y1, x2, y2], score, landmarks: [[x, y] x5]}] in picture pixels."""
    scale, pad_x, pad_y = placement
    by_kind = {1: [], 4: [], 10: []}
    for out in outputs:
        arr = np.asarray(out)
        last = arr.shape[-1]
        if last in by_kind:
            by_kind[last].append(arr.reshape(-1, last))
    for kind in by_kind.values():
        kind.sort(key=lambda a: -a.size)
    scores, boxes, kps = [], [], []
    for index, stride in enumerate(STRIDES):
        anchors = ANCHORS[index]
        score = by_kind[1][index].reshape(-1).astype(np.float64)
        dist = by_kind[4][index].astype(np.float64) * stride
        scores.append(score)
        boxes.append(np.stack([
            anchors[:, 0] - dist[:, 0], anchors[:, 1] - dist[:, 1],
            anchors[:, 0] + dist[:, 2], anchors[:, 1] + dist[:, 3],
        ], axis=1))
        if by_kind[10]:
            k = by_kind[10][index].astype(np.float64).reshape(-1, 5, 2) * stride
            kps.append(k + anchors[:, None, :])
    scores = np.concatenate(scores)
    boxes = np.concatenate(boxes)
    kps = np.concatenate(kps) if kps else None
    if scores.size and scores.max() > 1:
        scores = 1 / (1 + np.exp(-scores))
    keep = nms(boxes, scores)
    faces = []
    for i in keep:
        box = boxes[i]
        faces.append({
            "box": [float((box[0] - pad_x) / scale), float((box[1] - pad_y) / scale),
                    float((box[2] - pad_x) / scale), float((box[3] - pad_y) / scale)],
            "score": float(scores[i]),
            "landmarks": None if kps is None else [[float((x - pad_x) / scale), float((y - pad_y) / scale)] for x, y in kps[i]],
        })
    return faces


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    return inter / (area_a + area_b - inter + 1e-6)


def nms(boxes, scores):
    """The worker's NMS: over CONF_THRESH, best first, drop overlaps over NMS_THRESH."""
    order = [int(i) for i in np.flatnonzero(scores > CONF_THRESH)]
    order.sort(key=lambda i: -scores[i])  # stable, like Array.prototype.sort
    keep, suppressed = [], set()
    for i in order:
        if i in suppressed:
            continue
        keep.append(i)
        for j in order:
            if j != i and j not in suppressed and iou(boxes[i], boxes[j]) > NMS_THRESH:
                suppressed.add(j)
    return keep


def _svd2x2(m):
    a, b, c, d = m[0][0], m[0][1], m[1][0], m[1][1]
    s1 = a * a + b * b + c * c + d * d
    s2 = math.sqrt((a * a + b * b - c * c - d * d) ** 2 + 4 * (a * c + b * d) ** 2)
    sigma1 = math.sqrt((s1 + s2) / 2)
    sigma2 = math.sqrt(max(0.0, (s1 - s2) / 2))
    theta = 0.5 * math.atan2(2 * (a * c + b * d), a * a + b * b - c * c - d * d)
    phi = 0.5 * math.atan2(2 * (a * b + c * d), a * a - b * b + c * c - d * d)
    ct, st, cp, sp = math.cos(theta), math.sin(theta), math.cos(phi), math.sin(phi)
    return [[ct, -st], [st, ct]], [sigma1, sigma2], [[cp, -sp], [sp, cp]]


def estimate_umeyama(src, dst=ARCFACE_TEMPLATE):
    """The worker's similarity transform from landmarks to the template: (a, b, c, d, tx, ty), dst = [[a, b], [c, d]] src + t."""
    src = [(float(p[0]), float(p[1])) for p in src]
    dst = [(float(p[0]), float(p[1])) for p in dst]
    n = len(src)
    sm = [sum(p[0] for p in src) / n, sum(p[1] for p in src) / n]
    dm = [sum(p[0] for p in dst) / n, sum(p[1] for p in dst) / n]
    sd = [(p[0] - sm[0], p[1] - sm[1]) for p in src]
    dd = [(p[0] - dm[0], p[1] - dm[1]) for p in dst]
    src_var = sum(p[0] ** 2 + p[1] ** 2 for p in sd) / n
    cov = [[0.0, 0.0], [0.0, 0.0]]
    for (dx, dy), (sx, sy) in zip(dd, sd):
        cov[0][0] += dx * sx
        cov[0][1] += dx * sy
        cov[1][0] += dy * sx
        cov[1][1] += dy * sy
    cov = [[v / n for v in row] for row in cov]
    U, S, V = _svd2x2(cov)
    det = U[0][0] * U[1][1] - U[0][1] * U[1][0]
    det_v = V[0][0] * V[1][1] - V[0][1] * V[1][0]
    d = (1, -1 if det * det_v < 0 else 1)
    R = [
        [U[0][0] * V[0][0] * d[0] + U[0][1] * V[0][1] * d[1], U[0][0] * V[1][0] * d[0] + U[0][1] * V[1][1] * d[1]],
        [U[1][0] * V[0][0] * d[0] + U[1][1] * V[0][1] * d[1], U[1][0] * V[1][0] * d[0] + U[1][1] * V[1][1] * d[1]],
    ]
    scale = (S[0] * d[0] + S[1] * d[1]) / src_var
    tx = dm[0] - scale * (R[0][0] * sm[0] + R[0][1] * sm[1])
    ty = dm[1] - scale * (R[1][0] * sm[0] + R[1][1] * sm[1])
    return scale * R[0][0], scale * R[0][1], scale * R[1][0], scale * R[1][1], tx, ty


def aligned_face(rgb, landmarks):
    """The 112x112 RGB crop the worker draws with its canvas transform."""
    a, b, c, d, tx, ty = estimate_umeyama(landmarks)
    det = a * d - b * c
    ia, ib, ic, id_ = d / det, -b / det, -c / det, a / det
    ys, xs = np.mgrid[0:EMBED_SIZE, 0:EMBED_SIZE].astype(np.float64)
    px, py = xs + 0.5 - tx, ys + 0.5 - ty
    u = ia * px + ib * py  # source coordinates, pixel edges at integers
    v = ic * px + id_ * py
    h, w = rgb.shape[:2]
    inside = (u >= 0) & (u < w) & (v >= 0) & (v < h)
    u0, v0 = u - 0.5, v - 0.5
    x0f, y0f = np.floor(u0), np.floor(v0)
    fx = (u0 - x0f)[..., None]
    fy = (v0 - y0f)[..., None]
    x0 = np.clip(x0f, 0, w - 1).astype(np.int64)
    x1 = np.clip(x0f + 1, 0, w - 1).astype(np.int64)
    y0 = np.clip(y0f, 0, h - 1).astype(np.int64)
    y1 = np.clip(y0f + 1, 0, h - 1).astype(np.int64)
    img = rgb.astype(np.float64)
    top = img[y0, x0] * (1 - fx) + img[y0, x1] * fx
    bottom = img[y1, x0] * (1 - fx) + img[y1, x1] * fx
    out = _round8(top * (1 - fy) + bottom * fy)
    out[~inside] = 0
    return out


def embedding_input(face_rgb):
    planes = face_rgb[:, :, ::-1].transpose(2, 0, 1).astype(np.float32)
    return np.ascontiguousarray((planes / 127.5 - 1.0)[None])


def normalize(raw):
    raw = np.asarray(raw, dtype=np.float64).reshape(-1)
    return raw / math.sqrt(float(np.dot(raw, raw)))


class Pipeline:
    """Detection and embeddings with two onnxruntime sessions."""

    def __init__(self, det_session, rec_session):
        self.det = det_session
        self.rec = rec_session
        self.det_input = det_session.get_inputs()[0].name
        self.rec_input = rec_session.get_inputs()[0].name

    def detect(self, rgb):
        tensor, placement = detector_input(rgb)
        outputs = self.det.run(None, {self.det_input: tensor})
        return decode_detections(outputs, placement)

    def embed(self, rgb, landmarks):
        crop = aligned_face(rgb, landmarks)
        raw = self.rec.run(None, {self.rec_input: embedding_input(crop)})[0]
        return normalize(raw)


class Tracker:
    """
    Track ids across frames: a face overlapping one of the last frame's faces is
    the same track (best overlap first). A track keeps its embedding for up to
    reuse_s seconds while it overlaps by more than the worker's 0.45 (its
    TRACK_IOU_THRESH); then, or for a new track, the face is embedded again.
    """

    SAME_TRACK_IOU = 0.3
    REUSE_IOU = 0.45
    FORGET_S = 1.0

    def __init__(self, reuse_s=1.0):
        self.reuse_s = reuse_s
        self.tracks = []  # {id, box, embedding, embedded_at, seen_at}
        self.next_id = 1

    def assign(self, faces, now):
        """Sets face['track'] and face['reuse'] (an embedding to keep, or None)."""
        self.tracks = [t for t in self.tracks if now - t["seen_at"] <= self.FORGET_S]
        pairs = []
        for fi, face in enumerate(faces):
            for ti, track in enumerate(self.tracks):
                overlap = iou(face["box"], track["box"])
                if overlap > self.SAME_TRACK_IOU:
                    pairs.append((overlap, fi, ti))
        pairs.sort(key=lambda p: -p[0])
        used_f, used_t = set(), set()
        for overlap, fi, ti in pairs:
            if fi in used_f or ti in used_t:
                continue
            used_f.add(fi)
            used_t.add(ti)
            track = self.tracks[ti]
            face = faces[fi]
            face["track"] = track["id"]
            fresh = track["embedding"] is not None and now - track["embedded_at"] < self.reuse_s
            face["reuse"] = track["embedding"] if fresh and overlap > self.REUSE_IOU else None
        for fi, face in enumerate(faces):
            if fi not in used_f:
                face["track"] = self.next_id
                self.next_id += 1
                face["reuse"] = None

    def remember(self, faces, now):
        by_id = {t["id"]: t for t in self.tracks}
        kept = []
        for face in faces:
            track = by_id.get(face["track"]) or {"id": face["track"], "embedding": None, "embedded_at": 0.0}
            track["box"] = face["box"]
            track["seen_at"] = now
            if face.get("embedding") is not None and face.get("reuse") is None:
                track["embedding"] = face["embedding"]
                track["embedded_at"] = now
            kept.append(track)
        seen = {t["id"] for t in kept}
        self.tracks = kept + [t for t in self.tracks if t["id"] not in seen]

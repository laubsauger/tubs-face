// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TUBS BOT — Face Detection/Recognition Worker
//  Runs SCRFD (det_10g) + ArcFace (w600k_r50) via ONNX Runtime Web
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
const DET_MODEL_URL = 'https://huggingface.co/public-data/insightface/resolve/main/models/buffalo_l/det_10g.onnx';
const REC_MODEL_URL = 'https://huggingface.co/public-data/insightface/resolve/main/models/buffalo_l/w600k_r50.onnx';

let detSession = null;
let recSession = null;
let busy = false;
let frameCount = 0;

// ── Load ORT ──
importScripts(ORT_CDN + 'ort.min.js');

ort.env.wasm.wasmPaths = ORT_CDN;
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

// ── IndexedDB Model Cache ──
const DB_NAME = 'tubs-face-models';
const DB_VERSION = 1;
const STORE_NAME = 'models';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedModel(key) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function setCachedModel(key, buffer) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(buffer, key);
  } catch (e) {
    console.warn('[Worker] Cache write failed:', e);
  }
}

async function fetchModel(url, label) {
  const cached = await getCachedModel(url);
  if (cached) {
    postMessage({ type: 'progress', stage: label, detail: 'Loaded from cache' });
    return cached;
  }

  postMessage({ type: 'progress', stage: label, detail: 'Downloading...' });

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${label}: ${resp.status}`);

  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) {
      const pct = Math.round((received / total) * 100);
      postMessage({ type: 'progress', stage: label, detail: `${pct}% (${(received / 1e6).toFixed(1)}MB)` });
    }
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }

  await setCachedModel(url, buffer.buffer);
  postMessage({ type: 'progress', stage: label, detail: 'Downloaded & cached' });
  return buffer.buffer;
}

// ── Init Models ──
async function initModels() {
  postMessage({ type: 'progress', stage: 'init', detail: 'Loading detection model...' });
  const detBuf = await fetchModel(DET_MODEL_URL, 'Detection model');
  detSession = await ort.InferenceSession.create(detBuf, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });

  // Log model IO for debugging
  const detInputs = detSession.inputNames;
  const detOutputs = detSession.outputNames;
  postMessage({
    type: 'progress', stage: 'init',
    detail: `Det model: in=[${detInputs}] out=[${detOutputs.length} tensors]`
  });

  postMessage({ type: 'progress', stage: 'init', detail: 'Loading recognition model...' });
  const recBuf = await fetchModel(REC_MODEL_URL, 'Recognition model');
  recSession = await ort.InferenceSession.create(recBuf, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
  postMessage({ type: 'progress', stage: 'init', detail: 'Recognition model ready' });
}

// ── SCRFD Detection (det_10g.onnx) ──
// SCRFD outputs per stride: score(N,1), bbox(N,4), kps(N,10)
// Scores are sigmoid-activated. Boxes are distance-based (l,t,r,b) in pixel space.
const INPUT_SIZE = 640;
const STRIDES = [8, 16, 32];
const NMS_THRESH = 0.4;
const CONF_THRESH = 0.5;

// Generate anchor centers in pixel coordinates
function generateAnchors() {
  const anchors = []; // { cx, cy, stride }
  for (const stride of STRIDES) {
    const gridH = Math.ceil(INPUT_SIZE / stride);
    const gridW = Math.ceil(INPUT_SIZE / stride);
    for (let i = 0; i < gridH; i++) {
      for (let j = 0; j < gridW; j++) {
        // 2 anchors per cell
        const cx = (j + 0.5) * stride;
        const cy = (i + 0.5) * stride;
        anchors.push({ cx, cy, stride });
        anchors.push({ cx, cy, stride });
      }
    }
  }
  return anchors;
}

const ANCHORS = generateAnchors();

function nms(boxes, scores, threshold) {
  const indices = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > CONF_THRESH) indices.push(i);
  }
  indices.sort((a, b) => scores[b] - scores[a]);

  const keep = [];
  const suppressed = new Set();

  for (const i of indices) {
    if (suppressed.has(i)) continue;
    keep.push(i);
    for (const j of indices) {
      if (suppressed.has(j) || j === i) continue;
      if (iou(boxes[i], boxes[j]) > threshold) {
        suppressed.add(j);
      }
    }
  }
  return keep;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter + 1e-6);
}

async function detectFaces(imageData, width, height) {
  // Resize to 640x640 with letterboxing
  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext('2d');

  const scale = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
  const scaledW = Math.round(width * scale);
  const scaledH = Math.round(height * scale);
  const padX = Math.round((INPUT_SIZE - scaledW) / 2);
  const padY = Math.round((INPUT_SIZE - scaledH) / 2);

  const srcCanvas = new OffscreenCanvas(width, height);
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.putImageData(imageData, 0, 0);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(srcCanvas, padX, padY, scaledW, scaledH);

  const imgData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const pixels = imgData.data;

  // Preprocess: CHW float32, BGR order (OpenCV convention), (pixel - 127.5) / 128.0
  const float32 = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const pixelCount = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < pixelCount; i++) {
    float32[i]                  = (pixels[i * 4 + 2] - 127.5) / 128.0; // B
    float32[pixelCount + i]     = (pixels[i * 4 + 1] - 127.5) / 128.0; // G
    float32[2 * pixelCount + i] = (pixels[i * 4]     - 127.5) / 128.0; // R
  }

  const inputName = detSession.inputNames[0];
  const tensor = new ort.Tensor('float32', float32, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const results = await detSession.run({ [inputName]: tensor });

  // Classify outputs by their last dimension
  const outputNames = detSession.outputNames;
  const outputs = outputNames.map(name => ({
    name,
    data: results[name].data,
    dims: results[name].dims,
  }));

  // Group: dim1 = scores, dim4 = boxes, dim10 = landmarks
  // Within each group, sort by number of elements descending (stride 8 = most, stride 32 = least)
  const scoreOutputs = outputs.filter(o => o.dims[o.dims.length - 1] === 1).sort((a, b) => b.data.length - a.data.length);
  const boxOutputs   = outputs.filter(o => o.dims[o.dims.length - 1] === 4).sort((a, b) => b.data.length - a.data.length);
  const kpsOutputs   = outputs.filter(o => o.dims[o.dims.length - 1] === 10).sort((a, b) => b.data.length - a.data.length);

  // Diagnostic on first frame
  frameCount++;
  if (frameCount <= 2) {
    const diag = outputs.map(o => `${o.name}: [${o.dims.join(',')}]`).join(' | ');
    postMessage({ type: 'progress', stage: 'diag', detail: `Outputs: ${diag}` });
    postMessage({
      type: 'progress', stage: 'diag',
      detail: `Grouped: ${scoreOutputs.length} score, ${boxOutputs.length} box, ${kpsOutputs.length} kps`
    });
  }

  // Decode all detections
  const allScores = [];
  const allBoxes = [];
  const allLandmarks = [];

  let anchorOffset = 0;
  for (let si = 0; si < STRIDES.length; si++) {
    const stride = STRIDES[si];
    const gridH = Math.ceil(INPUT_SIZE / stride);
    const gridW = Math.ceil(INPUT_SIZE / stride);
    const numAnchors = gridH * gridW * 2;

    const scoreData = scoreOutputs[si] ? scoreOutputs[si].data : null;
    const boxData   = boxOutputs[si]   ? boxOutputs[si].data   : null;
    const kpsData   = kpsOutputs[si]   ? kpsOutputs[si].data   : null;

    if (!scoreData || !boxData) {
      anchorOffset += numAnchors;
      continue;
    }

    for (let a = 0; a < numAnchors; a++) {
      const anchor = ANCHORS[anchorOffset + a];
      const score = scoreData[a];

      allScores.push(score);

      // SCRFD box: distance from anchor center to edges (left, top, right, bottom)
      const l = boxData[a * 4 + 0] * stride;
      const t = boxData[a * 4 + 1] * stride;
      const r = boxData[a * 4 + 2] * stride;
      const b = boxData[a * 4 + 3] * stride;

      const x1 = anchor.cx - l;
      const y1 = anchor.cy - t;
      const x2 = anchor.cx + r;
      const y2 = anchor.cy + b;
      allBoxes.push([x1, y1, x2, y2]);

      // Landmarks: 5 points, each [dx, dy] relative to anchor
      if (kpsData) {
        const pts = [];
        for (let p = 0; p < 5; p++) {
          const lmx = anchor.cx + kpsData[a * 10 + p * 2] * stride;
          const lmy = anchor.cy + kpsData[a * 10 + p * 2 + 1] * stride;
          pts.push([lmx, lmy]);
        }
        allLandmarks.push(pts);
      } else {
        allLandmarks.push(null);
      }
    }

    anchorOffset += numAnchors;
  }

  // Check if scores are raw logits (max > 1.0) and need sigmoid
  let maxRawScore = 0;
  for (let i = 0; i < allScores.length; i++) {
    if (allScores[i] > maxRawScore) maxRawScore = allScores[i];
  }
  if (maxRawScore > 1.0) {
    // Scores are logits — apply sigmoid
    for (let i = 0; i < allScores.length; i++) {
      allScores[i] = 1.0 / (1.0 + Math.exp(-allScores[i]));
    }
  }

  // Diagnostic: score distribution
  if (frameCount <= 2) {
    let maxScore = 0;
    let above03 = 0, above05 = 0;
    for (let i = 0; i < allScores.length; i++) {
      if (allScores[i] > maxScore) maxScore = allScores[i];
      if (allScores[i] > 0.3) above03++;
      if (allScores[i] > 0.5) above05++;
    }
    postMessage({
      type: 'progress', stage: 'diag',
      detail: `Scores: total=${allScores.length}, max=${maxScore.toFixed(4)}, >0.3=${above03}, >0.5=${above05}, rawMax=${maxRawScore.toFixed(4)}${maxRawScore > 1 ? ' (sigmoid applied)' : ''}`
    });
  }

  // NMS
  const keepIdx = nms(allBoxes, allScores, NMS_THRESH);

  // Convert from 640x640 padded space to original image coordinates
  const faces = keepIdx.map(i => {
    const [bx1, by1, bx2, by2] = allBoxes[i];
    return {
      box: [
        (bx1 - padX) / scale,
        (by1 - padY) / scale,
        (bx2 - padX) / scale,
        (by2 - padY) / scale
      ],
      confidence: allScores[i],
      landmarks: allLandmarks[i] ? allLandmarks[i].map(([x, y]) => [
        (x - padX) / scale,
        (y - padY) / scale
      ]) : null
    };
  });

  return faces;
}

// ── ArcFace Recognition ──
const ARCFACE_TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041]
];

function estimateUmeyama(src, dst) {
  const n = src.length;

  let srcMean = [0, 0], dstMean = [0, 0];
  for (let i = 0; i < n; i++) {
    srcMean[0] += src[i][0]; srcMean[1] += src[i][1];
    dstMean[0] += dst[i][0]; dstMean[1] += dst[i][1];
  }
  srcMean[0] /= n; srcMean[1] /= n;
  dstMean[0] /= n; dstMean[1] /= n;

  const srcDm = src.map(p => [p[0] - srcMean[0], p[1] - srcMean[1]]);
  const dstDm = dst.map(p => [p[0] - dstMean[0], p[1] - dstMean[1]]);

  let srcVar = 0;
  for (let i = 0; i < n; i++) {
    srcVar += srcDm[i][0] ** 2 + srcDm[i][1] ** 2;
  }
  srcVar /= n;

  let cov = [[0, 0], [0, 0]];
  for (let i = 0; i < n; i++) {
    cov[0][0] += dstDm[i][0] * srcDm[i][0];
    cov[0][1] += dstDm[i][0] * srcDm[i][1];
    cov[1][0] += dstDm[i][1] * srcDm[i][0];
    cov[1][1] += dstDm[i][1] * srcDm[i][1];
  }
  cov[0][0] /= n; cov[0][1] /= n;
  cov[1][0] /= n; cov[1][1] /= n;

  const { U, S, V } = svd2x2(cov);

  const det = U[0][0] * U[1][1] - U[0][1] * U[1][0];
  const detV = V[0][0] * V[1][1] - V[0][1] * V[1][0];
  let d = [1, 1];
  if (det * detV < 0) d[1] = -1;

  const R = [
    [U[0][0] * V[0][0] * d[0] + U[0][1] * V[0][1] * d[1],
     U[0][0] * V[1][0] * d[0] + U[0][1] * V[1][1] * d[1]],
    [U[1][0] * V[0][0] * d[0] + U[1][1] * V[0][1] * d[1],
     U[1][0] * V[1][0] * d[0] + U[1][1] * V[1][1] * d[1]]
  ];

  const sc = (S[0] * d[0] + S[1] * d[1]) / srcVar;

  const tx = dstMean[0] - sc * (R[0][0] * srcMean[0] + R[0][1] * srcMean[1]);
  const ty = dstMean[1] - sc * (R[1][0] * srcMean[0] + R[1][1] * srcMean[1]);

  return { a: sc * R[0][0], b: sc * R[0][1], tx, c: sc * R[1][0], d: sc * R[1][1], ty };
}

function svd2x2(m) {
  const a = m[0][0], b = m[0][1], c = m[1][0], d = m[1][1];
  const s1 = a * a + b * b + c * c + d * d;
  const s2 = Math.sqrt((a * a + b * b - c * c - d * d) ** 2 + 4 * (a * c + b * d) ** 2);
  const sigma1 = Math.sqrt((s1 + s2) / 2);
  const sigma2 = Math.sqrt(Math.max(0, (s1 - s2) / 2));
  const theta = 0.5 * Math.atan2(2 * (a * c + b * d), a * a + b * b - c * c - d * d);
  const phi = 0.5 * Math.atan2(2 * (a * b + c * d), a * a - b * b + c * c - d * d);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const cp = Math.cos(phi), sp = Math.sin(phi);
  return { U: [[ct, -st], [st, ct]], S: [sigma1, sigma2], V: [[cp, -sp], [sp, cp]] };
}

async function extractEmbedding(imageData, width, height, landmarks) {
  const transform = estimateUmeyama(landmarks, ARCFACE_TEMPLATE);

  const srcCanvas = new OffscreenCanvas(width, height);
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.putImageData(imageData, 0, 0);

  const alignedCanvas = new OffscreenCanvas(112, 112);
  const alignedCtx = alignedCanvas.getContext('2d');

  alignedCtx.setTransform(transform.a, transform.c, transform.b, transform.d, transform.tx, transform.ty);
  alignedCtx.drawImage(srcCanvas, 0, 0);
  alignedCtx.resetTransform();

  const alignedData = alignedCtx.getImageData(0, 0, 112, 112);
  const pixels = alignedData.data;

  // ArcFace: BGR order (OpenCV convention), normalize to [-1, 1]
  const float32 = new Float32Array(3 * 112 * 112);
  for (let i = 0; i < 112 * 112; i++) {
    float32[i]              = (pixels[i * 4 + 2] / 127.5) - 1.0; // B
    float32[112 * 112 + i]  = (pixels[i * 4 + 1] / 127.5) - 1.0; // G
    float32[2 * 112 * 112 + i] = (pixels[i * 4] / 127.5) - 1.0;  // R
  }

  const tensor = new ort.Tensor('float32', float32, [1, 3, 112, 112]);
  const inputName = recSession.inputNames[0];
  const results = await recSession.run({ [inputName]: tensor });
  const outputName = recSession.outputNames[0];
  const raw = Array.from(results[outputName].data);

  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map(v => v / norm);
}

// ── Message Handler ──
self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'init') {
    try {
      await initModels();
      postMessage({ type: 'ready' });
    } catch (err) {
      postMessage({ type: 'error', message: `Init failed: ${err.message}` });
    }
    return;
  }

  if (type === 'detect') {
    if (busy) return;
    busy = true;

    try {
      const { width, height } = e.data;
      const imageData = new ImageData(new Uint8ClampedArray(e.data.imageBuffer), width, height);
      const t0 = performance.now();

      const faces = await detectFaces(imageData, width, height);

      // Extract embeddings for each detected face
      for (const face of faces) {
        if (!face.landmarks) { face.embedding = null; continue; }
        try {
          face.embedding = await extractEmbedding(imageData, width, height, face.landmarks);
        } catch (err) {
          console.warn('[Worker] Embedding failed:', err);
          face.embedding = null;
        }
      }

      const inferenceMs = Math.round(performance.now() - t0);
      postMessage({ type: 'faces', faces, inferenceMs });
    } catch (err) {
      postMessage({ type: 'error', message: err.message });
    } finally {
      busy = false;
    }
    return;
  }
};

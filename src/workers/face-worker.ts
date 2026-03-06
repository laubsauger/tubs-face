import * as ort from 'onnxruntime-web';
import ortWasmMjsUrl from '@ort-dist/ort-wasm-simd-threaded.mjs?url';
import ortWasmUrl from '@ort-dist/ort-wasm-simd-threaded.wasm?url';
import type { DetectedFace, FaceBox, FaceEmbedding, FaceLandmarks } from '../shared/contracts/faces.js';
import type {
  FaceWorkerFacesMessage,
  FaceWorkerProgressMessage,
  FaceWorkerRequestMessage,
  FaceWorkerResponseMessage,
} from '../shared/contracts/worker.js';

const DET_MODEL_URL = 'https://huggingface.co/public-data/insightface/resolve/main/models/buffalo_l/det_10g.onnx';
const REC_MODEL_URL = 'https://huggingface.co/public-data/insightface/resolve/main/models/buffalo_l/w600k_r50.onnx';

const DB_NAME = 'tubs-face-models';
const DB_VERSION = 1;
const STORE_NAME = 'models';

const INPUT_SIZE = 640;
const STRIDES = [8, 16, 32] as const;
const NMS_THRESH = 0.4;
const CONF_THRESH = 0.5;
const TRACK_IOU_THRESH = 0.45;
const TRACK_MAX_AGE = 8;

type NumericArrayLike = ArrayLike<number>;

interface TrackedFace {
  box: FaceBox;
  embedding: FaceEmbedding;
  age: number;
}

interface OrtOutput {
  name: string;
  data: NumericArrayLike;
  dims: readonly number[];
}

let detSession: ort.InferenceSession | null = null;
let recSession: ort.InferenceSession | null = null;
let busy = false;
let frameCount = 0;
let prevTracked: TrackedFace[] = [];

ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortWasmMjsUrl };
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const anchors = generateAnchors();
const inputFloat32 = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
const embFloat32 = new Float32Array(3 * 112 * 112);

let detSrcCanvas: OffscreenCanvas | null = null;
let detSrcCtx: OffscreenCanvasRenderingContext2D | null = null;
let detPadCanvas: OffscreenCanvas | null = null;
let detPadCtx: OffscreenCanvasRenderingContext2D | null = null;
let embSrcCanvas: OffscreenCanvas | null = null;
let embSrcCtx: OffscreenCanvasRenderingContext2D | null = null;
let embAlignedCanvas: OffscreenCanvas | null = null;
let embAlignedCtx: OffscreenCanvasRenderingContext2D | null = null;

self.onmessage = async (event: MessageEvent<FaceWorkerRequestMessage>) => {
  if (event.data.type === 'init') {
    try {
      await initModels();
      post({ type: 'ready' });
    } catch (error) {
      postError(`Init failed: ${toErrorMessage(error)}`);
    }
    return;
  }

  if (event.data.type === 'detect') {
    if (busy) {
      return;
    }

    busy = true;
    try {
      const { width, height, imageBuffer, requestId } = event.data;
      const imageData = new ImageData(new Uint8ClampedArray(imageBuffer), width, height);
      const startedAt = performance.now();
      const detectStartedAt = performance.now();
      const faces = await detectFaces(imageData, width, height);
      const detectMs = performance.now() - detectStartedAt;

      const usedTracked = new Set<number>();
      let embeddingsExtracted = 0;
      let embeddingsReused = 0;
      const embedStartedAt = performance.now();

      for (const face of faces) {
        if (!face.landmarks) {
          face.embedding = null;
          continue;
        }

        const trackedIndex = findTrackedMatch(face.box);
        if (trackedIndex !== -1 && !usedTracked.has(trackedIndex)) {
          const tracked = prevTracked[trackedIndex];
          if (tracked?.embedding && tracked.age < TRACK_MAX_AGE) {
            face.embedding = tracked.embedding;
            face._trackedAge = tracked.age + 1;
            usedTracked.add(trackedIndex);
            embeddingsReused += 1;
            continue;
          }
        }

        try {
          face.embedding = await extractEmbedding(imageData, width, height, face.landmarks);
          face._trackedAge = 0;
          embeddingsExtracted += 1;
        } catch (error) {
          console.warn('[face-worker] embedding failed:', error);
          face.embedding = null;
        }
      }

      prevTracked = faces
        .filter((face): face is DetectedFace & { embedding: FaceEmbedding } => Array.isArray(face.embedding))
        .map((face) => ({
          box: face.box,
          embedding: face.embedding,
          age: face._trackedAge ?? 0,
        }));

      const totalMs = performance.now() - startedAt;
      const message: FaceWorkerFacesMessage = {
        type: 'faces',
        faces,
        inferenceMs: Math.round(totalMs),
        embeddingsExtracted,
        embeddingsReused,
        stageTimings: {
          detectMs,
          embedMs: performance.now() - embedStartedAt,
          totalMs,
        },
        ...(requestId ? { requestId } : {}),
      };
      post(message);
    } catch (error) {
      postError(toErrorMessage(error), event.data.requestId);
    } finally {
      busy = false;
    }
  }
};

async function initModels(): Promise<void> {
  postProgress('init', 'Loading detection model...');
  const detBuffer = await fetchModel(DET_MODEL_URL, 'Detection model');
  detSession = await ort.InferenceSession.create(detBuffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  postProgress(
    'init',
    `Det model: in=[${detSession.inputNames.join(',')}] out=[${detSession.outputNames.length} tensors]`,
  );

  postProgress('init', 'Loading recognition model...');
  const recBuffer = await fetchModel(REC_MODEL_URL, 'Recognition model');
  recSession = await ort.InferenceSession.create(recBuffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  postProgress('init', 'Recognition model ready');
}

async function detectFaces(imageData: ImageData, width: number, height: number): Promise<DetectedFace[]> {
  const session = requireSession(detSession, 'detection');
  if (!detPadCanvas) {
    detPadCanvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
    detPadCtx = create2DContext(detPadCanvas, true);
  }

  const scale = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
  const scaledW = Math.round(width * scale);
  const scaledH = Math.round(height * scale);
  const padX = Math.round((INPUT_SIZE - scaledW) / 2);
  const padY = Math.round((INPUT_SIZE - scaledH) / 2);

  if (!detSrcCanvas || detSrcCanvas.width !== width || detSrcCanvas.height !== height) {
    detSrcCanvas = new OffscreenCanvas(width, height);
    detSrcCtx = create2DContext(detSrcCanvas);
  }
  const sourceCtx = detSrcCtx;
  const padCtx = detPadCtx;
  if (!sourceCtx || !padCtx) {
    throw new Error('Detection canvases are not initialized');
  }

  sourceCtx.putImageData(imageData, 0, 0);
  padCtx.fillStyle = '#000';
  padCtx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  padCtx.drawImage(detSrcCanvas, padX, padY, scaledW, scaledH);

  const pixels = padCtx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  const pixelCount = INPUT_SIZE * INPUT_SIZE;
  for (let index = 0; index < pixelCount; index += 1) {
    inputFloat32[index] = ((pixels[index * 4 + 2] ?? 0) - 127.5) / 128.0;
    inputFloat32[pixelCount + index] = ((pixels[index * 4 + 1] ?? 0) - 127.5) / 128.0;
    inputFloat32[2 * pixelCount + index] = ((pixels[index * 4] ?? 0) - 127.5) / 128.0;
  }

  const inputName = session.inputNames[0];
  if (!inputName) {
    throw new Error('Detection model missing input name');
  }

  const tensor = new ort.Tensor('float32', inputFloat32, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const results = await session.run({ [inputName]: tensor });
  const outputs = session.outputNames.map((name) => toOrtOutput(name, results[name] as ort.Tensor));

  frameCount += 1;

  const scoreOutputs = outputs.filter((output) => output.dims[output.dims.length - 1] === 1).sort(byLengthDesc);
  const boxOutputs = outputs.filter((output) => output.dims[output.dims.length - 1] === 4).sort(byLengthDesc);
  const kpsOutputs = outputs.filter((output) => output.dims[output.dims.length - 1] === 10).sort(byLengthDesc);

  const allScores: number[] = [];
  const allBoxes: FaceBox[] = [];
  const allLandmarks: Array<FaceLandmarks | null> = [];

  let anchorOffset = 0;
  for (let strideIndex = 0; strideIndex < STRIDES.length; strideIndex += 1) {
    const stride = STRIDES[strideIndex] ?? 8;
    const gridH = Math.ceil(INPUT_SIZE / stride);
    const gridW = Math.ceil(INPUT_SIZE / stride);
    const numAnchors = gridH * gridW * 2;

    const scoreData = scoreOutputs[strideIndex]?.data;
    const boxData = boxOutputs[strideIndex]?.data;
    const kpsData = kpsOutputs[strideIndex]?.data;
    if (!scoreData || !boxData) {
      anchorOffset += numAnchors;
      continue;
    }

    for (let anchorIndex = 0; anchorIndex < numAnchors; anchorIndex += 1) {
      const anchor = anchors[anchorOffset + anchorIndex];
      if (!anchor) {
        continue;
      }
      const score = scoreData[anchorIndex] ?? 0;
      allScores.push(score);

      const left = (boxData[anchorIndex * 4] ?? 0) * stride;
      const top = (boxData[anchorIndex * 4 + 1] ?? 0) * stride;
      const right = (boxData[anchorIndex * 4 + 2] ?? 0) * stride;
      const bottom = (boxData[anchorIndex * 4 + 3] ?? 0) * stride;

      allBoxes.push([
        anchor.cx - left,
        anchor.cy - top,
        anchor.cx + right,
        anchor.cy + bottom,
      ]);

      if (!kpsData) {
        allLandmarks.push(null);
        continue;
      }

      const points: FaceLandmarks = [];
      for (let pointIndex = 0; pointIndex < 5; pointIndex += 1) {
        const x = anchor.cx + (kpsData[anchorIndex * 10 + pointIndex * 2] ?? 0) * stride;
        const y = anchor.cy + (kpsData[anchorIndex * 10 + pointIndex * 2 + 1] ?? 0) * stride;
        points.push([x, y]);
      }
      allLandmarks.push(points);
    }

    anchorOffset += numAnchors;
  }

  let maxRawScore = 0;
  for (const score of allScores) {
    if (score > maxRawScore) {
      maxRawScore = score;
    }
  }
  if (maxRawScore > 1) {
    for (let index = 0; index < allScores.length; index += 1) {
      const score = allScores[index] ?? 0;
      allScores[index] = 1 / (1 + Math.exp(-score));
    }
  }

  const keepIndices = nms(allBoxes, allScores, NMS_THRESH);
  return keepIndices.map((index) => {
    const box = allBoxes[index] ?? [0, 0, 0, 0];
    const landmarks = allLandmarks[index];
    const score = allScores[index] ?? 0;
    return {
      box: [
        (box[0] - padX) / scale,
        (box[1] - padY) / scale,
        (box[2] - padX) / scale,
        (box[3] - padY) / scale,
      ],
      score,
      confidence: score,
      landmarks: landmarks
        ? landmarks.map(([x, y]) => [((x - padX) / scale), ((y - padY) / scale)] as [number, number])
        : null,
    } satisfies DetectedFace;
  });
}

async function extractEmbedding(
  imageData: ImageData,
  width: number,
  height: number,
  landmarks: FaceLandmarks,
): Promise<FaceEmbedding> {
  const session = requireSession(recSession, 'recognition');
  const transform = estimateUmeyama(landmarks, ARCFACE_TEMPLATE);

  if (!embSrcCanvas || embSrcCanvas.width !== width || embSrcCanvas.height !== height) {
    embSrcCanvas = new OffscreenCanvas(width, height);
    embSrcCtx = create2DContext(embSrcCanvas);
  }
  const sourceCtx = embSrcCtx;
  if (!sourceCtx) {
    throw new Error('Embedding source canvas is not initialized');
  }
  sourceCtx.putImageData(imageData, 0, 0);

  if (!embAlignedCanvas) {
    embAlignedCanvas = new OffscreenCanvas(112, 112);
    embAlignedCtx = create2DContext(embAlignedCanvas, true);
  }
  const alignedCtx = embAlignedCtx;
  if (!alignedCtx) {
    throw new Error('Embedding target canvas is not initialized');
  }

  alignedCtx.clearRect(0, 0, 112, 112);
  alignedCtx.setTransform(transform.a, transform.c, transform.b, transform.d, transform.tx, transform.ty);
  alignedCtx.drawImage(embSrcCanvas, 0, 0);
  alignedCtx.resetTransform();

  const pixels = alignedCtx.getImageData(0, 0, 112, 112).data;
  const pixelCount = 112 * 112;
  for (let index = 0; index < pixelCount; index += 1) {
    embFloat32[index] = (pixels[index * 4 + 2] ?? 0) / 127.5 - 1;
    embFloat32[pixelCount + index] = (pixels[index * 4 + 1] ?? 0) / 127.5 - 1;
    embFloat32[2 * pixelCount + index] = (pixels[index * 4] ?? 0) / 127.5 - 1;
  }

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) {
    throw new Error('Recognition model missing input/output names');
  }

  const tensor = new ort.Tensor('float32', embFloat32, [1, 3, 112, 112]);
  const results = await session.run({ [inputName]: tensor });
  const output = results[outputName] as ort.Tensor;
  const raw = Array.from(output.data as NumericArrayLike);
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}

function requireSession(session: ort.InferenceSession | null, kind: string): ort.InferenceSession {
  if (!session) {
    throw new Error(`${kind} model is not initialized`);
  }
  return session;
}

function toOrtOutput(name: string, tensor: ort.Tensor): OrtOutput {
  return {
    name,
    data: tensor.data as NumericArrayLike,
    dims: tensor.dims,
  };
}

function byLengthDesc(left: OrtOutput, right: OrtOutput): number {
  return right.data.length - left.data.length;
}

function create2DContext(canvas: OffscreenCanvas, willReadFrequently = false): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d', willReadFrequently ? { willReadFrequently: true } : undefined);
  if (!context) {
    throw new Error('2D canvas context is unavailable');
  }
  return context;
}

function generateAnchors(): Array<{ cx: number; cy: number; stride: number }> {
  const generated: Array<{ cx: number; cy: number; stride: number }> = [];
  for (const stride of STRIDES) {
    const gridH = Math.ceil(INPUT_SIZE / stride);
    const gridW = Math.ceil(INPUT_SIZE / stride);
    for (let row = 0; row < gridH; row += 1) {
      for (let col = 0; col < gridW; col += 1) {
        const cx = (col + 0.5) * stride;
        const cy = (row + 0.5) * stride;
        generated.push({ cx, cy, stride });
        generated.push({ cx, cy, stride });
      }
    }
  }
  return generated;
}

function nms(boxes: FaceBox[], scores: number[], threshold: number): number[] {
  const indices: number[] = [];
  for (let index = 0; index < scores.length; index += 1) {
    if ((scores[index] ?? 0) > CONF_THRESH) {
      indices.push(index);
    }
  }
  indices.sort((left, right) => (scores[right] ?? 0) - (scores[left] ?? 0));

  const keep: number[] = [];
  const suppressed = new Set<number>();
  for (const index of indices) {
    if (suppressed.has(index)) {
      continue;
    }
    keep.push(index);
    for (const candidate of indices) {
      if (candidate === index || suppressed.has(candidate)) {
        continue;
      }
      if (iou(boxes[index] ?? [0, 0, 0, 0], boxes[candidate] ?? [0, 0, 0, 0]) > threshold) {
        suppressed.add(candidate);
      }
    }
  }
  return keep;
}

function iou(a: FaceBox, b: FaceBox): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  return inter / (areaA + areaB - inter + 1e-6);
}

function findTrackedMatch(box: FaceBox): number {
  let bestIndex = -1;
  let bestIou = 0;
  for (let index = 0; index < prevTracked.length; index += 1) {
    const tracked = prevTracked[index];
    if (!tracked) {
      continue;
    }
    const overlap = iou(box, tracked.box);
    if (overlap > TRACK_IOU_THRESH && overlap > bestIou) {
      bestIou = overlap;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function estimateUmeyama(src: FaceLandmarks, dst: FaceLandmarks): {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
} {
  const n = src.length;
  const srcMean: [number, number] = [0, 0];
  const dstMean: [number, number] = [0, 0];
  for (let index = 0; index < n; index += 1) {
    srcMean[0] += src[index]?.[0] ?? 0;
    srcMean[1] += src[index]?.[1] ?? 0;
    dstMean[0] += dst[index]?.[0] ?? 0;
    dstMean[1] += dst[index]?.[1] ?? 0;
  }
  srcMean[0] /= n;
  srcMean[1] /= n;
  dstMean[0] /= n;
  dstMean[1] /= n;

  const srcDm = src.map((point) => [point[0] - srcMean[0], point[1] - srcMean[1]] as [number, number]);
  const dstDm = dst.map((point) => [point[0] - dstMean[0], point[1] - dstMean[1]] as [number, number]);

  let srcVar = 0;
  for (const point of srcDm) {
    srcVar += point[0] ** 2 + point[1] ** 2;
  }
  srcVar /= n;

  const cov: [[number, number], [number, number]] = [
    [0, 0],
    [0, 0],
  ];
  for (let index = 0; index < n; index += 1) {
    const dstPoint = dstDm[index] ?? [0, 0];
    const srcPoint = srcDm[index] ?? [0, 0];
    cov[0][0] += dstPoint[0] * srcPoint[0];
    cov[0][1] += dstPoint[0] * srcPoint[1];
    cov[1][0] += dstPoint[1] * srcPoint[0];
    cov[1][1] += dstPoint[1] * srcPoint[1];
  }
  cov[0][0] /= n;
  cov[0][1] /= n;
  cov[1][0] /= n;
  cov[1][1] /= n;

  const { U, S, V } = svd2x2(cov);
  const det = U[0][0] * U[1][1] - U[0][1] * U[1][0];
  const detV = V[0][0] * V[1][1] - V[0][1] * V[1][0];
  const d = [1, det * detV < 0 ? -1 : 1] as const;
  const R: [[number, number], [number, number]] = [
    [
      U[0][0] * V[0][0] * d[0] + U[0][1] * V[0][1] * d[1],
      U[0][0] * V[1][0] * d[0] + U[0][1] * V[1][1] * d[1],
    ],
    [
      U[1][0] * V[0][0] * d[0] + U[1][1] * V[0][1] * d[1],
      U[1][0] * V[1][0] * d[0] + U[1][1] * V[1][1] * d[1],
    ],
  ];

  const scale = (S[0] * d[0] + S[1] * d[1]) / srcVar;
  const tx = dstMean[0] - scale * (R[0][0] * srcMean[0] + R[0][1] * srcMean[1]);
  const ty = dstMean[1] - scale * (R[1][0] * srcMean[0] + R[1][1] * srcMean[1]);

  return {
    a: scale * R[0][0],
    b: scale * R[0][1],
    c: scale * R[1][0],
    d: scale * R[1][1],
    tx,
    ty,
  };
}

function svd2x2(matrix: number[][]): {
  U: [[number, number], [number, number]];
  S: [number, number];
  V: [[number, number], [number, number]];
} {
  const a = matrix[0]?.[0] ?? 0;
  const b = matrix[0]?.[1] ?? 0;
  const c = matrix[1]?.[0] ?? 0;
  const d = matrix[1]?.[1] ?? 0;
  const s1 = a * a + b * b + c * c + d * d;
  const s2 = Math.sqrt((a * a + b * b - c * c - d * d) ** 2 + 4 * (a * c + b * d) ** 2);
  const sigma1 = Math.sqrt((s1 + s2) / 2);
  const sigma2 = Math.sqrt(Math.max(0, (s1 - s2) / 2));
  const theta = 0.5 * Math.atan2(2 * (a * c + b * d), a * a + b * b - c * c - d * d);
  const phi = 0.5 * Math.atan2(2 * (a * b + c * d), a * a - b * b + c * c - d * d);
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  return {
    U: [[ct, -st], [st, ct]],
    S: [sigma1, sigma2],
    V: [[cp, -sp], [sp, cp]],
  };
}

async function fetchModel(url: string, label: string): Promise<ArrayBuffer> {
  const cached = await getCachedModel(url);
  if (cached) {
    postProgress(label, 'Loaded from cache');
    return cached;
  }

  postProgress(label, 'Downloading...');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${label}: ${response.status}`);
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    await setCachedModel(url, buffer);
    postProgress(label, 'Downloaded & cached');
    return buffer;
  }

  const total = Number.parseInt(response.headers.get('content-length') || '0', 10);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    chunks.push(value);
    received += value.length;
    if (total > 0) {
      const pct = Math.round((received / total) * 100);
      postProgress(label, `${pct}% (${(received / 1e6).toFixed(1)}MB)`);
    }
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  await setCachedModel(url, bytes.buffer);
  postProgress(label, 'Downloaded & cached');
  return bytes.buffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getCachedModel(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDb();
    return await new Promise<ArrayBuffer | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as ArrayBuffer | null) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function setCachedModel(key: string, buffer: ArrayBuffer): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(buffer, key);
  } catch (error) {
    console.warn('[face-worker] cache write failed:', error);
  }
}

function post(message: FaceWorkerResponseMessage): void {
  self.postMessage(message);
}

function postProgress(stage: FaceWorkerProgressMessage['stage'], detail: string): void {
  post({ type: 'progress', stage, detail });
}

function postError(message: string, requestId?: string): void {
  post({ type: 'error', message, ...(requestId ? { requestId } : {}) });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ARCFACE_TEMPLATE: FaceLandmarks = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

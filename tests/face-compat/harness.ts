// The browser face worker (src/workers/face-worker.ts) as the listener page
// runs it, through its own client, with nothing else around it. run.ts hands
// it pictures as raw RGBA, so both pipelines see the very same pixels.
import { createFaceWorkerClient } from '../../src/client/face/worker-client.js';

declare global {
  interface Window {
    faceHarness: {
      ready: Promise<void>;
      progress: string[];
      detect(rgba: string, width: number, height: number): Promise<unknown>;
    };
  }
}

const progress: string[] = [];
let markReady: () => void = () => {};
let markFailed: (error: Error) => void = () => {};
const ready = new Promise<void>((resolve, reject) => {
  markReady = resolve;
  markFailed = reject;
});

const worker = createFaceWorkerClient({
  onReady: () => markReady(),
  onProgress: (message) => progress.push(`${message.stage}: ${message.detail}`),
  onError: (message) => markFailed(new Error(message)),
});
worker.init();

function bytesOf(base64: string): Uint8ClampedArray {
  const binary = atob(base64);
  const out = new Uint8ClampedArray(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

window.faceHarness = {
  ready,
  progress,
  async detect(rgba, width, height) {
    // The worker reuses a tracked face's embedding for a face where one was in the last
    // frame (up to 8 frames): a black frame first, so each picture is embedded afresh.
    await worker.detectOnce(new ImageData(width, height));
    const result = await worker.detectOnce(new ImageData(bytesOf(rgba), width, height));
    return { faces: result.faces, inferenceMs: result.inferenceMs, crossOriginIsolated: self.crossOriginIsolated };
  },
};

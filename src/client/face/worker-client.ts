import type { FaceSnapshotPacket } from '../../shared/contracts/faces.js';
import type {
  FaceWorkerFacesMessage,
  FaceWorkerProgressMessage,
  FaceWorkerRequestMessage,
  FaceWorkerResponseMessage,
} from '../../shared/contracts/worker.js';

export interface FaceWorkerClientOptions {
  onReady?: () => void;
  onProgress?: (message: FaceWorkerProgressMessage) => void;
  onFaces?: (packet: FaceSnapshotPacket, message: FaceWorkerFacesMessage) => void;
  onError?: (message: string) => void;
}

export interface FaceWorkerClient {
  readonly ready: boolean;
  readonly busy: boolean;
  init(): void;
  detectImageData(imageData: ImageData, requestId?: string): void;
  detectBuffer(imageBuffer: ArrayBuffer, width: number, height: number, requestId?: string): void;
  detectOnce(imageData: ImageData): Promise<FaceWorkerFacesMessage>;
  terminate(): void;
}

export function createFaceWorkerClient(options: FaceWorkerClientOptions = {}): FaceWorkerClient {
  const worker = new Worker(new URL('../../workers/face-worker.ts', import.meta.url), { type: 'module' });
  const pendingRequests = new Map<string, { resolve: (value: FaceWorkerFacesMessage) => void; reject: (error: Error) => void }>();
  let ready = false;
  let busy = false;
  let requestCounter = 0;

  worker.onmessage = (event: MessageEvent<FaceWorkerResponseMessage>) => {
    const message = event.data;
    switch (message.type) {
      case 'ready':
        ready = true;
        options.onReady?.();
        return;
      case 'progress':
        options.onProgress?.(message);
        return;
      case 'faces':
        busy = false;
        if (message.requestId) {
          const pending = pendingRequests.get(message.requestId);
          if (pending) {
            pendingRequests.delete(message.requestId);
            pending.resolve(message);
          }
        }
        options.onFaces?.(
          {
            faces: message.faces,
            inferenceMs: message.inferenceMs,
            ts: Date.now(),
            embeddingsExtracted: message.embeddingsExtracted,
            embeddingsReused: message.embeddingsReused,
          },
          message,
        );
        return;
      case 'error':
        busy = false;
        if (message.requestId) {
          const pending = pendingRequests.get(message.requestId);
          if (pending) {
            pendingRequests.delete(message.requestId);
            pending.reject(new Error(message.message));
            return;
          }
        }
        options.onError?.(message.message);
        return;
      default:
        return;
    }
  };

  worker.onerror = (event) => {
    busy = false;
    options.onError?.(event.message || 'Face worker error');
  };

  return {
    get ready() {
      return ready;
    },
    get busy() {
      return busy;
    },
    init(): void {
      worker.postMessage({ type: 'init' } satisfies FaceWorkerRequestMessage);
    },
    detectImageData(imageData: ImageData, requestId?: string): void {
      this.detectBuffer(imageData.data.buffer.slice(0), imageData.width, imageData.height, requestId);
    },
    detectBuffer(imageBuffer: ArrayBuffer, width: number, height: number, requestId?: string): void {
      busy = true;
      const payload: FaceWorkerRequestMessage = {
        type: 'detect',
        imageBuffer,
        width,
        height,
        ...(requestId ? { requestId } : {}),
      };
      worker.postMessage(payload, [imageBuffer]);
    },
    detectOnce(imageData: ImageData): Promise<FaceWorkerFacesMessage> {
      return new Promise((resolve, reject) => {
        requestCounter += 1;
        const requestId = `face-${requestCounter}`;
        pendingRequests.set(requestId, { resolve, reject });
        this.detectImageData(imageData, requestId);
      });
    },
    terminate(): void {
      for (const pending of pendingRequests.values()) {
        pending.reject(new Error('Face worker terminated'));
      }
      pendingRequests.clear();
      worker.terminate();
      ready = false;
      busy = false;
    },
  };
}

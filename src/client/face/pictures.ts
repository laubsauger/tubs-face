// Pictures for face detection and vision (docs/vision.md). The page's own
// camera streams; a studio camera does not have to: a snapshot URL gives one
// JPEG per picture, a site node stream is opened only while a picture is
// taken. Either way detection and vision use the same picture.

/** The size to send a picture at: its longest side at most maxPx, aspect kept. */
export function fitWithin(width: number, height: number, maxPx: number): { width: number; height: number } {
  const scale = Math.min(1, maxPx / Math.max(1, width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A JPEG data URL of `source`, its longest side at most maxPx: what goes to the vision provider. */
export function visionFrame(source: HTMLCanvasElement, maxPx: number): string {
  const { width, height } = fitWithin(source.width, source.height, maxPx);
  if (width === source.width && height === source.height) return source.toDataURL('image/jpeg', 0.7);
  const scaled = document.createElement('canvas');
  scaled.width = width;
  scaled.height = height;
  scaled.getContext('2d')?.drawImage(source, 0, 0, width, height);
  return scaled.toDataURL('image/jpeg', 0.7);
}

/** One picture from a snapshot URL: exactly one request. */
export async function snapshotPicture(url: string, doFetch: typeof fetch = fetch): Promise<ImageBitmap> {
  const response = await doFetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`snapshot answered ${response.status}`);
  return createImageBitmap(await response.blob());
}

/** How often a still source (snapshot, site stream) takes a picture for detection. */
export const STILL_PICTURE_MS = 2000;

export interface StillPictures {
  stop(): void;
}

/**
 * Takes a picture every intervalMs while `ready()` (the face detector is up;
 * a picture nobody looks at costs a request or a stream for nothing), one at a
 * time: a slow grab delays the next instead of piling up.
 */
export function createStillPictures(options: {
  grab: () => Promise<ImageBitmap>;
  ready: () => boolean;
  onPicture: (picture: ImageBitmap) => Promise<void> | void;
  onError?: (message: string) => void;
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): StillPictures {
  const interval = options.intervalMs ?? STILL_PICTURE_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle as number));
  let timer: unknown = null;
  let stopped = false;

  const tick = async () => {
    timer = null;
    if (stopped) return;
    if (options.ready()) {
      try {
        const picture = await options.grab();
        if (!stopped) await options.onPicture(picture);
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : String(error));
      }
    }
    if (!stopped) timer = setTimer(() => void tick(), interval);
  };
  timer = setTimer(() => void tick(), 0);

  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

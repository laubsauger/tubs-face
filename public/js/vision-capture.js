const CAPTURE_WIDTH = 640;
const JPEG_QUALITY = 0.65;

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');

/**
 * Capture a JPEG frame from #camera-feed as base64 (no data: prefix).
 * Returns null if camera is not active.
 */
export function captureFrameBase64() {
    const video = document.getElementById('camera-feed');
    if (!video || video.paused || !video.videoWidth) return null;

    const scale = CAPTURE_WIDTH / video.videoWidth;
    canvas.width = CAPTURE_WIDTH;
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    // Strip "data:image/jpeg;base64," prefix
    const commaIdx = dataUrl.indexOf(',');
    return commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : null;
}

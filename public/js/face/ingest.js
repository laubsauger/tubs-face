
import { logChat } from '../chat-log.js';
import { runFaceDetectionOnImage } from './detection.js';

let isIngesting = false;

export async function checkAndRunIngestion() {
    if (isIngesting) return;

    try {
        const res = await fetch('/ingest/list');
        const data = await res.json();

        if (!data.files || data.files.length === 0) return;

        isIngesting = true;
        logChat('sys', `Found ${data.files.length} images to ingest...`);

        for (const file of data.files) {
            await processIngestFile(file);
        }

        logChat('sys', 'Ingestion complete.');
    } catch (err) {
        console.error('[Ingest] Error checking for files:', err);
    } finally {
        isIngesting = false;
    }
}

async function processIngestFile(file) {
    const { name, url, relPath } = file;
    // logChat('sys', `Processing ${name}...`); // Optional spam reduction

    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = async () => {
            try {
                // Run detection on the loaded image
                // We need to pass the img element directly to face-api
                const detections = await runFaceDetectionOnImage(img);

                if (detections && detections.length > 0) {
                    // Take the best face (largest area or highest score)
                    // Usually there's just one person per training image
                    const bestFace = detections[0]; // runFaceDetectionOnImage returns sorted by area/confidence usually
                    const embedding = Array.from(bestFace.descriptor);

                    // Upload embedding
                    await fetch('/faces', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: name,
                            embedding: embedding,
                            thumbnail: url // Use the source URL as thumbnail for now? or generate one?
                        })
                    });

                    logChat('sys', `Ingested: ${name}`);
                } else {
                    logChat('sys', `⚠️ No face found in ${file.filename}`);
                }

                // Mark done regardless of success to avoid infinite loop
                await fetch('/ingest/done', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ relPath })
                });

            } catch (err) {
                console.error(`[Ingest] Failed processing ${relPath}:`, err);
                logChat('sys', `Error processing ${file.filename}`);
            }
            resolve();
        };
        img.onerror = () => {
            console.error(`[Ingest] Failed loading image ${url}`);
            resolve();
        };
        img.src = url;
    });
}

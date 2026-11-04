// Video recordings from the face window: start, append a piece, finish, show in Finder.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse, RecordingFileRequest, RecordingFinishResponse, RecordingStartRequest, RecordingStartResponse } from '../../shared/contracts/http.js';
import { readJsonBody } from '../http/body.js';
import { sendJson, sendNoContent } from '../http/response.js';
import { appendChunk, createRecording, finishRecording, recordingsDir, revealRecording } from '../recordings.js';
import { badRequest } from './route-helpers.js';

// The browser sends a piece about every second; at 8 Mbit/s that is ~1 MB.
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

export async function handleRecordingRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (request.method !== 'POST' || !url.pathname.startsWith('/api/recordings')) return false;
  const dir = recordingsDir();

  try {
    switch (url.pathname) {
      case '/api/recordings': {
        const { ext } = await readJsonBody<RecordingStartRequest>(request);
        if (ext !== 'mp4' && ext !== 'webm') throw badRequest('ext must be mp4 or webm');
        const file = await createRecording(dir, ext);
        sendJson(response, 200, { file, dir } satisfies RecordingStartResponse);
        return true;
      }
      case '/api/recordings/chunk': {
        const offset = Number(url.searchParams.get('offset'));
        if (!Number.isSafeInteger(offset) || offset < 0) throw badRequest('Missing offset');
        await appendChunk(dir, url.searchParams.get('file'), offset, await readRawBody(request));
        sendNoContent(response);
        return true;
      }
      case '/api/recordings/finish': {
        const { file } = await readJsonBody<RecordingFileRequest>(request);
        sendJson(response, 200, await finishRecording(dir, file) satisfies RecordingFinishResponse);
        return true;
      }
      case '/api/recordings/reveal': {
        const { file } = await readJsonBody<RecordingFileRequest>(request);
        await revealRecording(dir, file);
        sendJson(response, 200, { ok: true });
        return true;
      }
      default:
        return false;
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const statusCode = name === 'BadRequestError' ? 400 : name === 'ConflictError' ? 409 : name === 'PayloadTooLargeError' ? 413 : 500;
    sendJson(response, statusCode, { error: error instanceof Error ? error.message : String(error) } satisfies ErrorResponse);
    return true;
  }
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_CHUNK_BYTES) {
      const error = new Error('Recording piece too large');
      error.name = 'PayloadTooLargeError';
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

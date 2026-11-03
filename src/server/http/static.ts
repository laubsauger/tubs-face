import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

// Built client (vite build). In dev the client is served by Vite instead.
const clientDir = resolve(process.cwd(), 'dist/client');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
};

/** Serves files from dist/client. Returns false when no file matches. */
export async function serveStatic(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    return false;
  }

  const filePath = resolve(clientDir, pathname === '/' ? 'index.html' : `.${pathname}`);
  if (!filePath.startsWith(clientDir + sep)) {
    return false;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return false;
    }
    const ext = extname(filePath).toLowerCase();
    // Vite emits content-hashed names under /assets, so those can be cached forever.
    const cacheControl = ext === '.html'
      ? 'no-cache'
      : pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600';
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': cacheControl,
    });
    if (request.method === 'HEAD') {
      response.end();
    } else {
      createReadStream(filePath).pipe(response);
    }
    return true;
  } catch {
    return false;
  }
}

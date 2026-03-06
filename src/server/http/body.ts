import type { IncomingMessage } from 'node:http';

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw) as T;
}

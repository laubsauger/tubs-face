// Helpers used by more than one route group.

import type { IncomingMessage } from 'node:http';

/** Same origin (the dashboard), or not a browser at all (curl on the venue network); never another site in the same browser. */
export function fromThisOrigin(request: IncomingMessage): boolean {
  const site = request.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = 'BadRequestError';
  return error;
}

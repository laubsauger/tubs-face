import type { ErrorResponse } from '../../shared/contracts/http.js';
import type { ServerResponse } from 'node:http';

export function applyCors(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Donation-Token');
}

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

export function sendNoContent(response: ServerResponse): void {
  response.writeHead(204);
  response.end();
}

export function sendError(response: ServerResponse, statusCode: number, message: string): void {
  const payload: ErrorResponse = { error: message };
  sendJson(response, statusCode, payload);
}

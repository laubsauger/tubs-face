import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}

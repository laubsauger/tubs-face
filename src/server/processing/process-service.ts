import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { runtimeConfig } from '../config/runtime.js';

const DEFAULT_REALTIME_PORT = Number.parseInt(process.env.REALTIME_PROCESSING_PORT || '3002', 10) || 3002;

export interface PythonServiceDefinition {
  scriptName: string;
  port: number;
  envFactory: () => NodeJS.ProcessEnv;
  logPrefix: string;
}

export interface PythonServiceController {
  start(): void;
  stop(timeoutMs?: number): Promise<boolean>;
  restart(): Promise<void>;
  proxyJson(pathname: string, body: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }>;
  postAudioMultipart(pathname: string, audioBuffer: Buffer, mimeType?: string): Promise<unknown>;
}

export function createPythonServiceController(definition: PythonServiceDefinition): PythonServiceController {
  const isWindows = process.platform === 'win32';
  const pythonPath = isWindows
    ? path.join(process.cwd(), 'venv', 'Scripts', 'python.exe')
    : path.join(process.cwd(), 'venv', 'bin', 'python');
  const scriptPath = path.join(process.cwd(), 'src', definition.scriptName);
  let processRef: ChildProcessWithoutNullStreams | null = null;

  return {
    start(): void {
      if (processRef) return;

      const child = spawn(pythonPath, ['-u', scriptPath], {
        env: definition.envFactory(),
      });
      processRef = child;

      child.stdout.on('data', (data: Buffer) => {
        console.log(`${definition.logPrefix} ${data.toString().trim()}`);
      });

      child.stderr.on('data', (data: Buffer) => {
        console.error(`${definition.logPrefix} ${data.toString().trim()}`);
      });

      child.on('close', () => {
        if (processRef === child) {
          processRef = null;
        }
      });

      child.on('error', (error) => {
        console.error(`${definition.logPrefix} failed to spawn`, error);
      });
    },

    async stop(timeoutMs = 5000): Promise<boolean> {
      if (!processRef) return false;
      const child = processRef;

      return new Promise<boolean>((resolve) => {
        let finished = false;

        const finalize = (value: boolean) => {
          if (finished) return;
          finished = true;
          resolve(value);
        };

        child.once('close', () => {
          if (processRef === child) {
            processRef = null;
          }
          finalize(true);
        });

        try {
          // Windows does not support POSIX signals — use taskkill for reliable tree kill.
          if (process.platform === 'win32' && child.pid !== undefined) {
            try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F']); } catch { /* ignore */ }
          } else {
            child.kill('SIGTERM');
          }
        } catch {
          finalize(false);
          return;
        }

        setTimeout(() => {
          if (finished) return;
          try {
            if (process.platform === 'win32' && child.pid !== undefined) {
              try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F']); } catch { /* ignore */ }
            } else {
              child.kill('SIGKILL');
            }
          } catch {
            // ignore
          }
        }, timeoutMs);

        setTimeout(() => finalize(false), timeoutMs + 500);
      });
    },

    async restart(): Promise<void> {
      await this.stop();
      if (processRef) {
        throw new Error(`Failed to stop ${definition.scriptName}`);
      }
      this.start();
    },

    proxyJson(pathname: string, body: string) {
      return proxyJsonRequest({
        hostname: '127.0.0.1',
        port: definition.port,
        path: pathname,
        body: Buffer.from(body),
        headers: {
          'Content-Type': 'application/json',
        },
      });
    },

    postAudioMultipart(pathname: string, audioBuffer: Buffer, mimeType = 'audio/webm') {
      return postAudioMultipart({
        hostname: '127.0.0.1',
        port: definition.port,
        path: pathname,
        audioBuffer,
        mimeType,
      });
    },
  };
}

function proxyJsonRequest(input: {
  hostname: string;
  port: number;
  path: string;
  body: Buffer;
  headers: Record<string, string>;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: input.hostname,
      port: input.port,
      path: input.path,
      method: 'POST',
      headers: {
        ...input.headers,
        'Content-Length': String(input.body.byteLength),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 502,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    request.on('error', reject);
    request.write(input.body);
    request.end();
  });
}

function postAudioMultipart(input: {
  hostname: string;
  port: number;
  path: string;
  audioBuffer: Buffer;
  mimeType: string;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const boundary = '---BOUNDARY';
    const normalizedMimeType = normalizeAudioMimeType(input.mimeType);
    const extension = normalizedMimeType === 'audio/wav' ? 'wav' : 'webm';
    const prefix = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="audio"; filename="audio.${extension}"\r\n` +
      `Content-Type: ${normalizedMimeType}\r\n\r\n`,
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([prefix, input.audioBuffer, suffix]);

    const request = http.request({
      hostname: input.hostname,
      port: input.port,
      path: input.path,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(payload.byteLength),
      },
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(body || 'Service request failed'));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid JSON from service'));
        }
      });
    });

    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

function normalizeAudioMimeType(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes('audio/wav') || normalized.includes('audio/x-wav') || normalized.includes('audio/wave')) {
    return 'audio/wav';
  }
  return 'audio/webm';
}

export function buildLegacyServiceEnv(sttModel = runtimeConfig.sttModel): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WHISPER_MODEL: sttModel,
    TTS_BACKEND: runtimeConfig.ttsBackend,
    STT_BACKEND: runtimeConfig.sttBackend,
    KOKORO_VOICE: runtimeConfig.kokoroVoice,
    HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
  };
}

export function buildRealtimeServiceEnv(sttModel = runtimeConfig.sttModel): NodeJS.ProcessEnv {
  return {
    ...process.env,
    REALTIME_PROCESSING_PORT: String(DEFAULT_REALTIME_PORT),
    REALTIME_STT_MODEL: sttModel,
    REALTIME_STT_BACKEND: runtimeConfig.sttBackend,
    REALTIME_TTS_BACKEND: runtimeConfig.ttsBackend,
    REALTIME_KOKORO_VOICE: runtimeConfig.kokoroVoice,
    STT_BACKEND: runtimeConfig.sttBackend,
    TTS_BACKEND: runtimeConfig.ttsBackend,
    KOKORO_VOICE: runtimeConfig.kokoroVoice,
    HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
  };
}

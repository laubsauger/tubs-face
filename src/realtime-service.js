const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { runtimeConfig, normalizeSttModel } = require('./config');

const DEFAULT_PORT = Number.parseInt(process.env.REALTIME_PROCESSING_PORT || '3002', 10) || 3002;
const pythonPath = path.join(__dirname, '../venv/bin/python');

let realtimeProcess = null;

function buildRealtimeChildEnv({ sttModel } = {}) {
  const resolvedModel = normalizeSttModel(sttModel || runtimeConfig.sttModel || process.env.REALTIME_STT_MODEL || process.env.WHISPER_MODEL || 'small');
  const resolvedSttBackend = String(
    runtimeConfig.sttBackend || process.env.REALTIME_STT_BACKEND || process.env.STT_BACKEND || 'mlx'
  ).trim().toLowerCase();
  const resolvedTtsBackend = String(
    runtimeConfig.ttsBackend || process.env.REALTIME_TTS_BACKEND || process.env.TTS_BACKEND || 'kokoro'
  ).trim().toLowerCase();
  const resolvedKokoroVoice = String(
    runtimeConfig.kokoroVoice || process.env.REALTIME_KOKORO_VOICE || process.env.KOKORO_VOICE || 'am_puck'
  ).trim().toLowerCase();

  return {
    resolvedModel,
    resolvedSttBackend,
    resolvedTtsBackend,
    resolvedKokoroVoice,
    env: {
      ...process.env,
      REALTIME_PROCESSING_PORT: String(DEFAULT_PORT),
      REALTIME_STT_MODEL: resolvedModel,
      REALTIME_STT_BACKEND: resolvedSttBackend,
      REALTIME_TTS_BACKEND: resolvedTtsBackend,
      REALTIME_KOKORO_VOICE: resolvedKokoroVoice,
      // Keep shared vars in sync to avoid split-brain config across modes.
      STT_BACKEND: resolvedSttBackend,
      TTS_BACKEND: resolvedTtsBackend,
      KOKORO_VOICE: resolvedKokoroVoice,
    },
  };
}

function getRealtimeServicePort() {
  return DEFAULT_PORT;
}

function startRealtimeProcessingService({ sttModel } = {}) {
  const {
    resolvedModel,
    resolvedSttBackend,
    resolvedTtsBackend,
    resolvedKokoroVoice,
    env,
  } = buildRealtimeChildEnv({ sttModel });
  console.log(
    `[Bridge] Spawning realtime processing service (port=${DEFAULT_PORT}, sttModel=${resolvedModel}, sttBackend=${resolvedSttBackend}, ttsBackend=${resolvedTtsBackend}, voice=${resolvedKokoroVoice})...`
  );

  const proc = spawn(
    pythonPath,
    ['-u', path.join(__dirname, 'realtime-processing-service.py')],
    { env }
  );

  realtimeProcess = proc;

  proc.stdout.on('data', (data) => {
    console.log(`[RealtimePy] ${data.toString().trim()}`);
  });

  proc.stderr.on('data', (data) => {
    console.error(`[RealtimePy Err] ${data.toString().trim()}`);
  });

  proc.on('error', (err) => {
    console.error('[RealtimePy] Failed to spawn process:', err);
  });

  proc.on('close', (code, signal) => {
    if (realtimeProcess === proc) {
      realtimeProcess = null;
    }
    console.log(`[RealtimePy] Exited with code ${code} signal=${signal || 'none'}`);
    if (code !== 0 && signal == null) {
      setTimeout(() => {
        if (!realtimeProcess) {
          console.log('[RealtimePy] Auto-restarting...');
          startRealtimeProcessingService({ sttModel: resolvedModel });
        }
      }, 2000);
    }
  });
}

function stopRealtimeProcessingService(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!realtimeProcess) {
      resolve(false);
      return;
    }

    const proc = realtimeProcess;
    let done = false;
    const finish = (didStop) => {
      if (done) return;
      done = true;
      resolve(didStop);
    };

    proc.once('close', () => {
      if (realtimeProcess === proc) {
        realtimeProcess = null;
      }
      finish(true);
    });

    try {
      proc.kill('SIGTERM');
    } catch {
      finish(false);
      return;
    }

    setTimeout(() => {
      if (done) return;
      try {
        proc.kill('SIGKILL');
      } catch {
        // no-op
      }
    }, timeoutMs);

    setTimeout(() => finish(false), timeoutMs + 500);
  });
}

async function restartRealtimeProcessingService(modelName, reason = 'runtime config update') {
  const resolvedModel = normalizeSttModel(modelName);
  console.log(`[Bridge] Restarting realtime processing service (${reason}) with STT=${resolvedModel}...`);
  await stopRealtimeProcessingService();
  if (realtimeProcess) {
    const err = new Error('Failed to stop existing realtime processing service process');
    err.code = 'REALTIME_RESTART_FAILED';
    throw err;
  }
  startRealtimeProcessingService({ sttModel: resolvedModel });
}

function normalizeAudioMimeType(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized.includes('audio/wav') || normalized.includes('audio/x-wav') || normalized.includes('audio/wave')) {
    return 'audio/wav';
  }
  return 'audio/webm';
}

function transcribeAudioRealtime(audioBuffer, mimeType = 'audio/webm') {
  return new Promise((resolve, reject) => {
    const boundary = '---BOUNDARY';
    const safeMimeType = normalizeAudioMimeType(mimeType);
    const extension = safeMimeType === 'audio/wav' ? 'wav' : 'webm';

    const tryRequest = (retries = 10) => {
      const req = http.request({
        hostname: 'localhost',
        port: DEFAULT_PORT,
        path: '/transcribe',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error('Invalid JSON from realtime processing service'));
            }
          } else {
            reject(new Error(`Realtime transcription failed: ${body}`));
          }
        });
      });

      req.on('error', (err) => {
        if (retries > 0 && err.code === 'ECONNREFUSED') {
          console.log(`[Bridge] Realtime processing service unavailable, retrying... (${retries})`);
          setTimeout(() => tryRequest(retries - 1), 2000);
        } else {
          reject(err);
        }
      });

      req.write(`--${boundary}\r\n`);
      req.write(`Content-Disposition: form-data; name="audio"; filename="audio.${extension}"\r\n`);
      req.write(`Content-Type: ${safeMimeType}\r\n\r\n`);
      req.write(audioBuffer);
      req.write(`\r\n--${boundary}--\r\n`);
      req.end();
    };

    tryRequest();
  });
}

function getRealtimeTtsProxyTarget() {
  return {
    hostname: 'localhost',
    port: DEFAULT_PORT,
    path: '/tts',
  };
}

module.exports = {
  getRealtimeServicePort,
  startRealtimeProcessingService,
  stopRealtimeProcessingService,
  restartRealtimeProcessingService,
  transcribeAudioRealtime,
  getRealtimeTtsProxyTarget,
};

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { runtimeConfig, normalizeSttModel } = require('./config');

let pythonProcess = null;
const pythonPath = path.join(__dirname, '../venv/bin/python');

function startTranscriptionService(modelName = runtimeConfig.sttModel) {
  const resolvedModel = normalizeSttModel(modelName);
  runtimeConfig.sttModel = resolvedModel;
  console.log(`[Bridge] Spawning Python service (Whisper=${resolvedModel})...`);

  const proc = spawn(
    pythonPath,
    ['-u', path.join(__dirname, 'transcription-service.py')],
    {
      env: {
        ...process.env,
        WHISPER_MODEL: resolvedModel,
        TTS_BACKEND: runtimeConfig.ttsBackend || 'kokoro',
        STT_BACKEND: runtimeConfig.sttBackend || 'mlx',
      },
    }
  );
  pythonProcess = proc;

  proc.stdout.on('data', (data) => {
    console.log(`[Python] ${data.toString().trim()}`);
  });

  proc.stderr.on('data', (data) => {
    console.error(`[Python Err] ${data.toString().trim()}`);
  });

  proc.on('error', (err) => {
    console.error('[Python] Failed to spawn process:', err);
  });

  proc.on('close', (code, signal) => {
    if (pythonProcess === proc) {
      pythonProcess = null;
    }
    console.log(`[Python] Exited with code ${code} signal=${signal || 'none'}`);

    // Auto-restart only on non-zero exit code without a shutdown signal.
    if (code !== 0 && signal == null) {
      console.error(`\n${'='.repeat(60)}\n[CRASH] Python TTS/STT service died (exit code ${code})\n${'='.repeat(60)}\n`);
      setTimeout(() => {
        if (!pythonProcess) {
          console.log('[Python] Auto-restarting...');
          startTranscriptionService(runtimeConfig.sttModel);
        }
      }, 2000);
    }
  });
}

function stopTranscriptionService(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!pythonProcess) {
      resolve(false);
      return;
    }

    const proc = pythonProcess;
    let done = false;
    const finish = (didStop) => {
      if (done) return;
      done = true;
      resolve(didStop);
    };

    proc.once('close', () => {
      if (pythonProcess === proc) {
        pythonProcess = null;
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

async function restartTranscriptionService(modelName, reason = 'runtime config update') {
  const resolvedModel = normalizeSttModel(modelName);
  console.log(`[Bridge] Restarting transcription service (${reason}) with Whisper=${resolvedModel}...`);
  await stopTranscriptionService();
  if (pythonProcess) {
    const err = new Error('Failed to stop existing transcription service process');
    err.code = 'STT_RESTART_FAILED';
    throw err;
  }
  startTranscriptionService(resolvedModel);
}

function normalizeAudioMimeType(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized.includes('audio/wav') || normalized.includes('audio/x-wav') || normalized.includes('audio/wave')) {
    return 'audio/wav';
  }
  return 'audio/webm';
}

function transcribeAudio(audioBuffer, mimeType = 'audio/webm') {
  return new Promise((resolve, reject) => {
    const boundary = '---BOUNDARY';
    const safeMimeType = normalizeAudioMimeType(mimeType);
    const extension = safeMimeType === 'audio/wav' ? 'wav' : 'webm';

    const tryRequest = (retries = 10) => {
      const req = http.request({
        hostname: 'localhost',
        port: 3001,
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
            } catch (e) {
              reject(new Error('Invalid JSON from transcription service'));
            }
          } else {
            reject(new Error(`Transcription failed: ${body}`));
          }
        });
      });

      req.on('error', (err) => {
        if (retries > 0 && err.code === 'ECONNREFUSED') {
          console.log(`[Bridge] Transcription service busy/loading, retrying... (${retries})`);
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

module.exports = {
  startTranscriptionService,
  stopTranscriptionService,
  restartTranscriptionService,
  transcribeAudio,
};

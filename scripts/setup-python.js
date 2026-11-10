#!/usr/bin/env node
// Cross-platform Python setup dispatcher.
// On Windows: runs scripts/setup-python.ps1 via PowerShell.
// On Unix/macOS: runs scripts/setup-python.sh via bash.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isWindows = process.platform === 'win32';

if (isWindows) {
  const ps1 = path.join(__dirname, 'setup-python.ps1');
  console.log('[setup-python] Detected Windows - running setup-python.ps1');
  execFileSync(
    'powershell.exe',
    ['-ExecutionPolicy', 'Bypass', '-File', ps1],
    { stdio: 'inherit' },
  );
} else {
  const sh = path.join(__dirname, 'setup-python.sh');
  console.log('[setup-python] Detected Unix - running setup-python.sh');
  execFileSync('bash', [sh], { stdio: 'inherit' });
}

// A first install gets a .env to fill in (the voices and both heads are set; the API key isn't).
const root = path.dirname(__dirname);
const env = path.join(root, '.env');
if (!existsSync(env) && existsSync(path.join(root, '.env.example'))) {
  copyFileSync(path.join(root, '.env.example'), env);
  console.log('[setup] Created .env from .env.example: put your GEMINI_API_KEY in it.');
}

// Tubs and Mini speak with their cloned voices (Ming, Apple Silicon only). Set it up here, so a new
// machine gets them with npm install; a failure is shown loudly and the server refuses to report ready.
if (process.platform === 'darwin' && process.arch === 'arm64' && process.env.TUBS_SKIP_MING !== '1') {
  try {
    execFileSync('bash', [path.join(__dirname, 'setup-ming.sh')], { stdio: 'inherit' });
  } catch {
    console.error('\n[setup-ming] ERROR: the Ming voices are NOT set up, so Tubs and Mini cannot speak.');
    console.error('             Fix what it says above, then run: npm run setup-ming\n');
  }
} else if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.warn('[setup-ming] Not Apple Silicon: no Ming. Set Kokoro voices in .env on purpose (REALTIME_KOKORO_VOICE=hm_omega, SECONDARY_VOICE=jf_tebukuro).');
}

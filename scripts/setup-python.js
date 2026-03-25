#!/usr/bin/env node
// Cross-platform Python setup dispatcher.
// On Windows: runs scripts/setup-python.ps1 via PowerShell.
// On Unix/macOS: runs scripts/setup-python.sh via bash.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isWindows = process.platform === 'win32';

if (isWindows) {
  const ps1 = path.join(__dirname, 'setup-python.ps1');
  console.log('[setup-python] Detected Windows — running setup-python.ps1');
  execFileSync(
    'powershell.exe',
    ['-ExecutionPolicy', 'Bypass', '-File', ps1],
    { stdio: 'inherit' },
  );
} else {
  const sh = path.join(__dirname, 'setup-python.sh');
  console.log('[setup-python] Detected Unix — running setup-python.sh');
  execFileSync('bash', [sh], { stdio: 'inherit' });
}

import fs from 'node:fs';
import path from 'node:path';

const INITIAL_ENV_KEYS = new Set(Object.keys(process.env));
const repoRoot = process.cwd();
const mode = String(process.env.NODE_ENV || '').trim();

loadServerEnv();

function loadServerEnv(): void {
  for (const envPath of resolveEnvPaths()) {
    if (!fs.existsSync(envPath)) {
      continue;
    }

    const parsed = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
    for (const [key, value] of parsed) {
      if (INITIAL_ENV_KEYS.has(key)) {
        continue;
      }
      process.env[key] = value;
    }
  }
}

function resolveEnvPaths(): string[] {
  const paths = [
    path.join(repoRoot, '.env'),
    path.join(repoRoot, '.env.local'),
  ];

  if (mode.length > 0) {
    paths.push(path.join(repoRoot, `.env.${mode}`));
    paths.push(path.join(repoRoot, `.env.${mode}.local`));
  }

  return paths;
}

function parseEnvFile(source: string): Map<string, string> {
  const parsed = new Map<string, string>();

  for (const rawLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    const rawValue = match[2] ?? '';
    if (!key) {
      continue;
    }
    parsed.set(key, normalizeEnvValue(rawValue));
  }

  return parsed;
}

function normalizeEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    const unquoted = trimmed.slice(1, -1);
    return quote === '"'
      ? unquoted
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
      : unquoted;
  }

  const commentIndex = trimmed.search(/\s#/);
  return commentIndex >= 0 ? trimmed.slice(0, commentIndex).trim() : trimmed;
}

export {};

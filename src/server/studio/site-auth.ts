// Logins for the studio site node (mediamtx): TUBS_STUDIO_SITE_AUTH names a
// local file with the user and password the face pages publish with (WHIP);
// TUBS_STUDIO_SITE_READ_AUTH one for reading (WHEP), if the site needs it.
// The file holds them, never the env, a URL or a log: the server turns them
// into an Authorization header that only the studio face pages receive (in
// their studio_config). A file that is missing or unreadable is an error
// GET /studio shows for each head.
//
// File formats: {"user": "...", "pass": "..."} (or username/password), a line
// "user:pass", or the user on one line and the password on the next.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface SiteLogin {
  /** "Basic …", for WHIP (publish). */
  publish?: string;
  /** "Basic …", for WHEP (read), when the site needs a read login. */
  read?: string;
}

const cache = new Map<string, { mtimeMs: number; result: { header: string } | { problem: string } }>();

function parseLogin(text: string): { user: string; pass: string } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      const user = json.user ?? json.username;
      const pass = json.pass ?? json.password;
      return typeof user === 'string' && user && typeof pass === 'string' && pass ? { user, pass } : null;
    } catch {
      return null;
    }
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0]!.includes(':')) {
    const at = lines[0]!.indexOf(':');
    const user = lines[0]!.slice(0, at);
    const pass = lines[0]!.slice(at + 1);
    return user && pass ? { user, pass } : null;
  }
  if (lines.length === 2) return { user: lines[0]!, pass: lines[1]! };
  return null;
}

/** The header for one env var's file: null when unset, or a problem that never includes the secret. */
export function loginHeader(envName: 'TUBS_STUDIO_SITE_AUTH' | 'TUBS_STUDIO_SITE_READ_AUTH'): { header: string } | { problem: string } | null {
  const configured = process.env[envName]?.trim();
  if (!configured) return null;
  const file = path.resolve(configured);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return { problem: `${envName}: ${file} is missing` };
  }
  const known = cache.get(file);
  if (known && known.mtimeMs === mtimeMs) return known.result;
  let result: { header: string } | { problem: string };
  try {
    const login = parseLogin(readFileSync(file, 'utf8'));
    result = login
      ? { header: `Basic ${Buffer.from(`${login.user}:${login.pass}`).toString('base64')}` }
      : { problem: `${envName}: ${file} holds no user and password ({"user","pass"}, user:pass, or two lines)` };
  } catch {
    result = { problem: `${envName}: ${file} is not readable` };
  }
  cache.set(file, { mtimeMs, result });
  return result;
}

/** What the face pages get with their studio_config. */
export function siteLogin(): SiteLogin {
  const publish = loginHeader('TUBS_STUDIO_SITE_AUTH');
  const read = loginHeader('TUBS_STUDIO_SITE_READ_AUTH');
  return {
    ...(publish && 'header' in publish ? { publish: publish.header } : {}),
    ...(read && 'header' in read ? { read: read.header } : {}),
  };
}

/** A problem with the configured login files, for GET /studio; null when fine or unset. */
export function siteLoginProblem(): string | null {
  for (const envName of ['TUBS_STUDIO_SITE_AUTH', 'TUBS_STUDIO_SITE_READ_AUTH'] as const) {
    const result = loginHeader(envName);
    if (result && 'problem' in result) return result.problem;
  }
  return null;
}

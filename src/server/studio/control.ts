// Turns studio mode on and off: the launcher brings the face pages up or down
// (unless something else opens them), and every page hears the new settings.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StudioResponse } from '../../shared/contracts/studio.js';
import { broadcast } from '../ws/server.js';
import { DEFAULT_CHROME_PATH, createStudioLauncher, defaultProfileRoot, type StudioLauncher } from './launcher.js';
import { anyPagePublishing, applyStudioPatch, noteLauncherError, streamName, studioConfigMessage, studioSettings, toStudioResponse } from './state.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const FACE_SIZE = Number.parseInt(process.env.TUBS_STUDIO_SIZE ?? '1024', 10) || 1024;

let launcher: StudioLauncher | null = null;
/** How long a face page gets to end its stream before its Chrome is closed. */
const PAGE_STOP_GRACE_MS = 1500;

/**
 * Where the launched Chrome finds the face page: TUBS_STUDIO_PAGE_BASE, else
 * this server when the client is built (npm start), else the Vite dev server.
 */
export function studioPageBase(): string {
  const configured = process.env.TUBS_STUDIO_PAGE_BASE?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  if (existsSync(resolve(process.cwd(), 'dist/client/studio-face.html'))) return `http://127.0.0.1:${port}`;
  return `http://127.0.0.1:${process.env.VITE_PORT ?? '5173'}`;
}

function getLauncher(): StudioLauncher {
  launcher ??= createStudioLauncher({
    chromePath: process.env.TUBS_STUDIO_CHROME?.trim() || DEFAULT_CHROME_PATH,
    profileRoot: defaultProfileRoot(port),
    pageUrl: (actor) => `${studioPageBase()}/studio-face.html?actor=${actor}&size=${FACE_SIZE}`,
    onError: noteLauncherError,
  });
  return launcher;
}

/**
 * Pages told that studio mode is off end their WHIP sessions themselves.
 * Closing Chrome first leaves the site node holding a dead stream until its
 * ICE timeout (~30 s), and a renderer keeps showing the frozen last frame.
 */
async function letPagesStopPublishing(): Promise<void> {
  const started = Date.now();
  while (anyPagePublishing() && Date.now() - started < PAGE_STOP_GRACE_MS) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Brings the pages in line with the settings (startup, and after every change). */
async function syncPages(): Promise<void> {
  if (studioSettings.launch !== 'chrome') return;
  if (!studioSettings.enabled && !launcher) return;
  if (!studioSettings.enabled) await letPagesStopPublishing();
  await getLauncher().sync(studioSettings.enabled);
}

export async function startStudio(): Promise<void> {
  if (studioSettings.enabled) {
    console.log(`[studio] on: faces to ${studioSettings.site}/${streamName('main')} and /${streamName('small')}, mic ${studioSettings.micSource}, pages ${studioSettings.launch === 'chrome' ? `in Chrome from ${studioPageBase()}` : 'opened externally'}`);
  }
  await syncPages();
}

/** POST /studio. Throws a BadRequestError for an invalid body (nothing changes then). */
export async function updateStudio(patch: unknown): Promise<StudioResponse> {
  const changed = applyStudioPatch(patch);
  if (changed.length > 0) {
    console.log(`[studio] ${changed.map((key) => `${key}=${String(studioSettings[key])}`).join(' ')}`);
    // Pages follow site and micSource live; only enabled starts or stops them.
    broadcast(studioConfigMessage());
    if (changed.includes('enabled')) await syncPages();
  }
  return toStudioResponse();
}

/** Server shutdown: the streams end cleanly and no face page outlives the server. */
export async function stopStudio(): Promise<void> {
  if (studioSettings.enabled && anyPagePublishing()) {
    broadcast({ ...studioConfigMessage(), enabled: false });
    await letPagesStopPublishing();
  }
  await launcher?.stop();
}

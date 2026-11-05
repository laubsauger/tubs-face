import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ExpressionName } from '../../src/shared/contracts/config.js';
import type { AppState } from '../../src/client/state/app-state.js';
import {
  DEFAULT_CONFIG,
  EXPRESSION_PROFILES,
  GAZE_MOUTH_RANGE_X,
  GAZE_MOUTH_RANGE_Y,
  SPEAK_MAX_SCALE,
  SPEAK_MIN_SCALE,
} from '../../src/client/glitch/constants.js';
import { buildPixelGrid } from '../../src/client/glitch/pixel-grid.js';
import { MOCK, resetMock, send, tone } from './helpers.js';

// Mini Tubs is a second character on stage because the audience sees its
// mouth move while Mini talks. Mini's subtitle must never sit on it: not in the
// tile in the face window, at any size or placement the stage settings offer,
// and not in the mini window.

interface Box { x: number; y: number; width: number; height: number }

// Wide letters, so even one subtitle segment (the controller cuts at 36
// characters) wraps onto a second line at every size checked here: the worst
// case the subtitle has to fit under the face.
const TWO_LINES = 'MMMMMMMMMM WWWWWWWWW MMMMMMMMMMMMMMM';

/**
 * Where the renderer draws the mouth in a face box this size (the canvas fills
 * the box), in any expression: the shape from glitch/pixel-grid.ts, opened as
 * wide as talking gets (SPEAK_MAX_SCALE, a quarter more when worked up, see
 * getSpeakMouthScale) and moved by the gaze to its limits. Nothing is drawn
 * outside the canvas.
 */
function mouthRegion(face: Box): Box {
  const open = SPEAK_MIN_SCALE + (SPEAK_MAX_SCALE - SPEAK_MIN_SCALE) * 1.25;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const expression of Object.keys(EXPRESSION_PROFILES) as ExpressionName[]) {
    if (expression === 'sleep') continue; // no subtitle while asleep
    const state = { sleeping: false, currentExpression: expression } as AppState;
    const { pixelGrid, shapeCenters } = buildPixelGrid(state, DEFAULT_CONFIG, face.width, face.height, 1, 0);
    const cy = shapeCenters[2]!.cy;
    for (const pixel of pixelGrid) {
      if (pixel.group !== 2) continue;
      left = Math.min(left, pixel.x);
      right = Math.max(right, pixel.x + 1);
      top = Math.min(top, cy + (pixel.y - cy) * open);
      bottom = Math.max(bottom, cy + (pixel.y + 1 - cy) * open);
    }
  }
  left = Math.max(0, left - GAZE_MOUTH_RANGE_X * face.width);
  right = Math.min(face.width, right + GAZE_MOUTH_RANGE_X * face.width);
  top = Math.max(0, top - GAZE_MOUTH_RANGE_Y * face.height);
  bottom = Math.min(face.height, bottom + GAZE_MOUTH_RANGE_Y * face.height);
  return { x: face.x + left, y: face.y + top, width: right - left, height: bottom - top };
}

/** Boxes that only touch (within layout rounding) don't cover each other. */
function overlap(a: Box, b: Box): boolean {
  const slack = 0.5;
  return a.x + slack < b.x + b.width && b.x + slack < a.x + a.width
    && a.y + slack < b.y + b.height && b.y + slack < a.y + a.height;
}

async function waitForClients(page: Page, request: APIRequestContext, count: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const { clients } = await (await request.get(`${MOCK}/__test/clients`)).json() as { clients: number };
    if (clients >= count) return;
    await page.waitForTimeout(100);
  }
}

async function miniSays(request: APIRequestContext, text: string): Promise<void> {
  const turnId = `t-mini-${Date.now()}`;
  await send(request,
    { type: 'turn_start', turnId },
    { type: 'turn_script', turnId, beats: [{ actor: 'small', action: 'speak', text }], ts: Date.now() },
    { type: 'audio_chunk', audio: tone(6000), text, turnId, chunkIndex: 0, actor: 'small', beatIndex: 0 },
    { type: 'speak_end', turnId, actor: 'small', text, fullText: text },
  );
}

/** Mini's subtitle is up: two lines, wholly on Mini's screen, and clear of the mouth. */
async function expectSubtitleClearOfMouth(subtitle: Locator, face: Locator, screen: Box): Promise<void> {
  await expect(subtitle).toHaveClass(/is-visible/, { timeout: 10_000 });
  // Line breaks depend on the font: measure once the web font is in (or given up on).
  const lines = await subtitle.evaluate(async (element) => {
    await document.fonts.ready;
    const style = getComputedStyle(element);
    const content = element.getBoundingClientRect().height
      - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
    return Math.round(content / parseFloat(style.lineHeight));
  });

  const sub = (await subtitle.boundingBox())!;
  const mouth = mouthRegion((await face.boundingBox())!);
  expect(overlap(sub, mouth), `subtitle ${JSON.stringify(sub)} covers the mouth ${JSON.stringify(mouth)}`).toBe(false);
  expect(lines, 'the worst case: a two-line subtitle').toBe(2);
  // Clear of the mouth by being on screen, not by being pushed off it.
  expect(sub.x).toBeGreaterThanOrEqual(screen.x);
  expect(sub.y).toBeGreaterThanOrEqual(screen.y);
  expect(sub.x + sub.width).toBeLessThanOrEqual(screen.x + screen.width + 0.5);
  expect(sub.y + sub.height).toBeLessThanOrEqual(screen.y + screen.height + 0.5);
}

test.afterEach(async ({ request }) => {
  await resetMock(request);
});

for (const placement of ['bottom-right', 'side'] as const) {
  for (const size of ['small', 'medium', 'large'] as const) {
    test(`Mini's subtitle leaves the mouth visible in the ${size} ${placement} tile`, async ({ page, request }) => {
      await resetMock(request);
      // Perform mode: the audience's view of the face window.
      await page.addInitScript((prefs) => {
        localStorage.setItem('tubs.stagePrefs', JSON.stringify(prefs));
        localStorage.setItem('tubs.uiPrefs', JSON.stringify({ uiHidden: true }));
      }, { miniTile: true, miniPlacement: placement, miniSize: size });
      await page.goto('/');
      await waitForClients(page, request, 1);
      await request.post(`${MOCK}/config`, { data: { dualHeadEnabled: true, dualHeadMode: 'llm_directed' } });
      await expect(page.locator('#mini-tile iframe')).toBeVisible();
      await waitForClients(page, request, 2);
      const mini = page.frameLocator('#mini-tile iframe');
      await mini.locator('#visual-face').waitFor();

      await miniSays(request, TWO_LINES);
      const tile = (await page.locator('#mini-tile').boundingBox())!;
      await expectSubtitleClearOfMouth(mini.locator('#visual-subtitle'), mini.locator('#visual-face'), tile);
    });
  }
}

// The size the face window opens it at, and a short, wide window.
for (const [width, height] of [[560, 420], [800, 450]] as const) {
  test(`Mini's subtitle leaves the mouth visible in a ${width}x${height} mini window`, async ({ page, request }) => {
    await resetMock(request);
    await page.setViewportSize({ width, height });
    await page.goto('/app-mini.html');
    await waitForClients(page, request, 1);
    await request.post(`${MOCK}/config`, { data: { dualHeadEnabled: true, dualHeadMode: 'llm_directed' } });
    await page.locator('#visual-face').waitFor();

    await miniSays(request, TWO_LINES);
    await expectSubtitleClearOfMouth(page.locator('#visual-subtitle'), page.locator('#visual-face'), { x: 0, y: 0, width, height });
  });
}

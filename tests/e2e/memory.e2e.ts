import { expect, test, type Page } from '@playwright/test';
import type { MemoryResponse } from '../../src/shared/contracts/memory.js';
import { resetMock } from './helpers.js';

// The memory view puts everything about a person on one card with their
// photos, and nothing changes without a second, deliberate click on that card.

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

const MEMORY: MemoryResponse = {
  cards: [
    {
      key: 'name:flo', name: 'Flo', names: ['Flo'], enrolled: true,
      library: Array.from({ length: 8 }, (_, i) => ({ id: `flo${i}`, createdAt: i, photo: `/memory/photo/flo${i}` })),
      photos: Array.from({ length: 8 }, (_, i) => ({ url: `/memory/photo/flo${i}`, source: 'library' as const, at: i })),
      otherPhotos: [], seenTonight: true, firstSeenAt: Date.now() - 600_000, lastSeenAt: Date.now(), returning: true, turns: 4,
      notes: ['building a robot'], quotes: ['one more track'],
      attitude: 'He is the boss. Be warm and nice to him (playful respect, never grovelling); still yourself.', inView: 'left',
    },
    {
      key: 'visitor:v7', name: null, names: [], enrolled: false, library: [],
      photos: [{ url: '/memory/snapshot/v7', source: 'snapshot', at: 1 }], otherPhotos: [],
      seenTonight: true, firstSeenAt: Date.now() - 300_000, lastSeenAt: Date.now() - 120_000, returning: false, turns: 2,
      notes: ['works night shifts at the bakery'], quotes: [], attitude: null, inView: null,
    },
  ],
  groupNotes: [], unattributedNotes: [], library: [{ name: 'Flo', samples: 8 }], relationshipsEnabled: true,
  counts: { tonight: 2, inView: 1, enrolled: 1 },
};

async function fakeMemoryServer(page: Page): Promise<Array<{ path: string; body: unknown }>> {
  const posts: Array<{ path: string; body: unknown }> = [];
  await page.route(/\/memory(\/.*)?$/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      posts.push({ path, body: request.postDataJSON() as unknown });
      await route.fulfill({ json: { ok: true } });
    } else if (path === '/memory') {
      await route.fulfill({ json: MEMORY });
    } else {
      await route.fulfill({ body: JPEG, contentType: 'image/jpeg' });
    }
  });
  return posts;
}

test.afterEach(async ({ request }) => {
  await resetMock(request);
});

test('one card per person, with their photos, notes, quotes, relationship and where they are', async ({ page }) => {
  await fakeMemoryServer(page);
  await page.goto('/?view=memory');
  const flo = page.getByRole('region', { name: 'Flo' });
  await expect(flo).toBeVisible();
  await expect(flo.locator('img.memory-photo')).toHaveCount(6);
  await expect(flo).toContainText('+2');
  await expect(flo).toContainText('in view, on the left');
  await expect(flo).toContainText('face library · 8 samples');
  await expect(flo).toContainText('building a robot');
  await expect(flo).toContainText('one more track');
  await expect(flo).toContainText('He is the boss');
  const visitor = page.getByRole('region', { name: 'Unknown visitor' });
  await expect(visitor.locator('img.memory-photo')).toHaveCount(1);
  await expect(visitor).toContainText('works night shifts at the bakery');
  await expect(visitor.getByRole('button', { name: 'Remove from face library' })).toHaveCount(0);
  expect(await page.title()).toBe('Tubs Memory');
});

test('a removal needs a second click on the card, and Cancel changes nothing', async ({ page }) => {
  const posts = await fakeMemoryServer(page);
  await page.goto('/?view=memory');
  const flo = page.getByRole('region', { name: 'Flo' });
  await flo.getByRole('button', { name: 'Remove from face library' }).click();
  await expect(flo).toContainText("Delete Flo's 8 face library samples and photos?");
  await flo.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(200);
  expect(posts).toEqual([]);

  await flo.getByRole('button', { name: 'Remove from face library' }).click();
  await flo.getByRole('button', { name: 'Delete from library' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/memory/library/remove', body: { name: 'Flo' } }]);

  await page.getByRole('region', { name: 'Unknown visitor' }).getByRole('button', { name: 'Forget tonight' }).click();
  await page.getByRole('region', { name: 'Unknown visitor' }).getByRole('button', { name: 'Forget', exact: true }).click();
  await expect.poll(() => posts.at(-1)).toEqual({ path: '/memory/forget', body: { key: 'visitor:v7' } });
});

test('the dashboard has it as a Memory tab, and it fits a laptop screen', async ({ page }) => {
  await fakeMemoryServer(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?view=dashboard');
  await page.getByRole('tab', { name: /^Memory/ }).click();
  const flo = page.locator('#dock-panel-memory').getByRole('region', { name: 'Flo' });
  await expect(flo).toBeVisible();
  const box = await flo.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
});

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
      library: Array.from({ length: 8 }, (_, i) => ({ id: `flo${i}`, createdAt: i, photo: `/memory/photo/flo${i}`, index: i + 1, flag: null })),
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

/** Rapha's third photo is nearer Flo's than his own (the audit's flag). */
const WITH_RAPHA: MemoryResponse = {
  ...MEMORY,
  cards: [
    ...MEMORY.cards,
    {
      key: 'name:rapha', name: 'Rapha', names: ['Rapha'], enrolled: true,
      library: Array.from({ length: 6 }, (_, i) => ({
        id: `rapha${i + 1}`, createdAt: new Date(2026, 1, 11, 21, 40 + i).getTime(), photo: `/memory/photo/rapha${i + 1}`, index: i + 1,
        flag: i === 2 ? { looksLike: { name: 'Flo', sim: 0.753 }, unlikeOwn: true, like: { name: 'Flo', sim: 0.753 } } : null,
      })),
      photos: Array.from({ length: 6 }, (_, i) => ({ url: `/memory/photo/rapha${i + 1}`, source: 'library' as const, at: i })),
      otherPhotos: [], seenTonight: false, firstSeenAt: null, lastSeenAt: null, returning: false, turns: 0,
      notes: [], quotes: [], attitude: null, inView: null,
    },
  ],
  library: [{ name: 'Flo', samples: 8 }, { name: 'Rapha', samples: 6 }, { name: 'Dimi', samples: 10 }],
};

async function fakeMemoryServer(page: Page, memory: MemoryResponse = MEMORY): Promise<Array<{ path: string; body: unknown }>> {
  const posts: Array<{ path: string; body: unknown }> = [];
  await page.route(/\/memory(\/.*)?$/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      posts.push({ path, body: request.postDataJSON() as unknown });
      await route.fulfill({ json: path.startsWith('/memory/library/') ? { ok: true, summary: 'Done.', undo: 'u1', until: Date.now() + 60_000 } : { ok: true } });
    } else if (path === '/memory') {
      await route.fulfill({ json: memory });
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
  await expect(flo).toContainText('Remove from face library: deletes all 8 face samples of Flo permanently; Tubs stops recognising Flo. Tonight\'s notes stay. It cannot be undone after a minute (a backup is kept).');
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

test('a flagged photo shows what it looks like, and moves to that person in two clicks, with an undo', async ({ page }) => {
  const posts = await fakeMemoryServer(page, WITH_RAPHA);
  await page.goto('/?view=memory');
  const rapha = page.getByRole('region', { name: 'Rapha' });
  await expect(rapha).toContainText('1 photo to check');
  await rapha.getByRole('button', { name: 'Check photos (1 flagged)' }).click();
  const third = rapha.locator('[data-sample="rapha3"]');
  await expect(third).toContainText('looks like Flo · 75%');
  await expect(third).toContainText('unlike Rapha\'s others');
  await third.getByRole('button', { name: 'Move Rapha #3 to…' }).click();
  // The person it resembles is picked already.
  await expect(rapha.getByRole('combobox')).toHaveValue('Flo');
  await expect(rapha).toContainText('Move 1 photo from Rapha to Flo (taken 11 Feb 21:42): Tubs matches it as Flo from now on (Flo then has 9); Rapha keeps 5 samples.');
  await page.waitForTimeout(200);
  expect(posts).toEqual([]);
  await rapha.getByRole('button', { name: 'Move to Flo' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/memory/library/samples/move', body: { ids: ['rapha3'], to: 'Flo' } }]);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(() => posts.at(-1)).toEqual({ path: '/memory/library/undo', body: { undo: 'u1' } });

  // Several at once: select two, remove them.
  await rapha.getByRole('checkbox', { name: 'Select Rapha #1' }).check();
  await rapha.getByRole('checkbox', { name: 'Select Rapha #2' }).check();
  await rapha.getByRole('button', { name: 'Remove selected' }).click();
  await expect(rapha).toContainText('Remove 2 photos of Rapha (taken 11 Feb 21:40 to 11 Feb 21:41)');
  await rapha.getByRole('button', { name: 'Remove 2 photos' }).click();
  await expect.poll(() => posts.at(-1)).toEqual({ path: '/memory/library/samples/remove', body: { ids: ['rapha1', 'rapha2'] } });
});

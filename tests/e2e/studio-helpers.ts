import { expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { MOCK, resetMock } from './helpers.js';

// Shared by the studio tests: the fake site node (mediamtx) and opening a face page.

export const SITE = 'http://127.0.0.1:39011';

export interface SiteRequest { method: string; path: string; body: string }

/** Answers WHIP/WHEP on the fake site node and records what the page asked for. */
export async function fakeSiteNode(page: Page, answer: (request: SiteRequest) => { status: number } = () => ({ status: 201 })): Promise<SiteRequest[]> {
  const requests: SiteRequest[] = [];
  // The page is on another origin than the site node, as in the studio.
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'Location',
  };
  await page.route(`${SITE}/**`, async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const entry = { method: request.method(), path, body: request.postData() ?? '' };
    requests.push(entry);
    if (request.method() === 'DELETE') {
      await route.fulfill({ status: 200, headers: cors, body: '' });
      return;
    }
    const { status } = answer(entry);
    await route.fulfill({
      status,
      headers: { ...cors, 'Content-Type': 'application/sdp', Location: `${path}/session-${requests.length}` },
      body: status === 201 ? 'v=0\r\n' : 'nope',
    });
  });
  return requests;
}

async function connectedPages(request: APIRequestContext): Promise<number> {
  return ((await (await request.get(`${MOCK}/__test/clients`)).json()) as { clients: number }).clients;
}

export async function openStudio(page: Page, request: APIRequestContext, actor: 'main' | 'small'): Promise<void> {
  await resetMock(request);
  await page.goto(`/studio-face.html?actor=${actor}`);
  await expect.poll(() => connectedPages(request)).toBeGreaterThan(0);
  await page.locator('#visual-face').waitFor();
}

export async function setStudio(request: APIRequestContext, patch: Record<string, unknown>): Promise<void> {
  const response = await request.post(`${MOCK}/studio`, { data: patch });
  expect(response.ok()).toBe(true);
}


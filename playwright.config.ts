import { defineConfig } from '@playwright/test';

// Browser tests for what the audience sees and hears: speech playback,
// interrupts, subtitles, the face's speaking state and the operator panels.
// They run the real client (Vite) against a scripted mock server, in the
// locally installed Chrome, so no browser download is needed.
const MOCK_PORT = 39010;
const VITE_PORT = 39190;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${VITE_PORT}`,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    },
  },
  webServer: [
    {
      command: 'npx tsx tests/e2e/mock-server.ts',
      url: `http://127.0.0.1:${MOCK_PORT}/health`,
      env: { MOCK_PORT: String(MOCK_PORT) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${VITE_PORT} --strictPort`,
      url: `http://127.0.0.1:${VITE_PORT}`,
      env: { TUBS_API_PORT: String(MOCK_PORT) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});

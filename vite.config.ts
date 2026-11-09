import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
// Where /api, /config, /ws etc. are proxied. The browser tests point it at a mock server.
const apiPort = Number(process.env.TUBS_API_PORT || 3000);
// Cross-origin isolation, so the face worker can run its models on several
// threads (SharedArrayBuffer). "credentialless" lets cross-origin requests that
// opt into nothing (the Google Fonts stylesheet) load without credentials.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  appType: 'mpa',
  publicDir: path.resolve(rootDir, 'public'),
  server: {
    headers: isolationHeaders,
    proxy: {
      '^/(health|stats|config|speak|incoming|voice|tts|wake|sleep|faces|api|checkout|donations|webhooks|shapes|ingest|turn-script|relationships|memory|presets)': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
      // Studio mode control; not the face page, studio-face.html.
      '^/studio(?:/snapshot)?(?:\\?.*)?$': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    headers: isolationHeaders,
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  resolve: {
    alias: {
      '@client': path.resolve(rootDir, 'src/client'),
      '@server': path.resolve(rootDir, 'src/server'),
      '@shared': path.resolve(rootDir, 'src/shared'),
      '@workers': path.resolve(rootDir, 'src/workers'),
      '@scripts': path.resolve(rootDir, 'src/scripts'),
      '@ort-dist': path.resolve(rootDir, 'node_modules/onnxruntime-web/dist'),
    },
  },
  build: {
    outDir: 'dist/client',
    target: 'esnext',
    rollupOptions: {
      input: {
        main: path.resolve(rootDir, 'index.html'),
        mini: path.resolve(rootDir, 'app-mini.html'),
        spectator: path.resolve(rootDir, 'spectator.html'),
        studio: path.resolve(rootDir, 'studio-face.html'),
      },
    },
  },
  worker: {
    format: 'es',
  },
});

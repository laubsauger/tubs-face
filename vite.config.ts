import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  appType: 'mpa',
  publicDir: path.resolve(rootDir, 'public'),
  server: {
    proxy: {
      '^/(health|stats|config|speak|voice|tts|wake|sleep|faces|api|checkout|donations|webhooks|shapes|ingest|turn-script)': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:3000',
        changeOrigin: true,
        ws: true,
      },
    },
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
      },
    },
  },
  worker: {
    format: 'es',
  },
});

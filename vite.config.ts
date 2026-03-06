import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  appType: 'mpa',
  publicDir: path.resolve(rootDir, 'public'),
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
    rollupOptions: {
      input: {
        main: path.resolve(rootDir, 'index.html'),
        mini: path.resolve(rootDir, 'app-mini.html'),
      },
    },
  },
});

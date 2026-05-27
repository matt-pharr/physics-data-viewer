import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { execSync } from 'node:child_process';

/**
 * Capture the short git SHA at build time so the About tab can show
 * which commit a given build was produced from. Falls back to
 * 'unknown' if git isn't available (e.g. building outside a clone).
 */
function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_SHA__: JSON.stringify(gitSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 5173,
  },
  base: './',
  build: {
    outDir: 'dist',
    rolldownOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        moduleWindow: resolve(__dirname, 'module-window.html'),
        guiEditor: resolve(__dirname, 'gui-editor.html'),
        guiViewer: resolve(__dirname, 'gui-viewer.html'),
      },
    },
  },
});

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import packageJson from './package.json'

// Absolute, forward-slashed glob for a folder directly under the project root.
// The watcher matches absolute paths, so root-anchored globs are the only way
// to ignore `<root>/data` without also ignoring `src/data`.
const projectRoot = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const rootGlob = (dir: string) => `${projectRoot}/${dir}/**`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  // Use relative asset paths so index.html works when loaded via Electron's
  // loadFile() (file:// protocol). Without this, Vite emits /assets/... which
  // resolves to the filesystem root, not the dist folder.
  base: './',
  server: {
    host: process.env.HOST || '127.0.0.1',
    // The dev server serves any file under the project root, and `data/` is
    // under the project root: settings.json, apikeys.vault, embeddings.db and
    // every campaign were reachable at http://localhost:5173/data/… (with a
    // directory listing). Harmless on loopback, not under `npm run dev:lan`.
    // A user-supplied `deny` REPLACES Vite's defaults, so they are restated.
    // Anchored to the root so `src/data/` (imported by the app) stays served.
    fs: {
      deny: [
        '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
        rootGlob('data'),
      ],
    },
    // Non-app folders live inside the project root (planning docs, campaign
    // JSON the server writes at runtime, tool output). Editing anything in
    // them would otherwise trigger a full page reload mid-session. Anchored to
    // the project root so nested app folders (e.g. src/data) still hot-reload.
    watch: {
      ignored: [
        rootGlob('Upgrade'),
        rootGlob('TRASH'),
        rootGlob('graphify-out'),
        rootGlob('data'),
        rootGlob('playwright-report'),
        rootGlob('.claude'),
      ],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/assets': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})

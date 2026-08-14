import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import packageJson from './package.json'

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

import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Frontend only: no backend and no access to campaign files.
export default defineConfig({
    testDir: '.', testMatch: 'worldMapTravel.spec.ts', timeout: 60000,
    use: { baseURL: 'http://127.0.0.1:5175', headless: true, screenshot: 'only-on-failure' },
    webServer: {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        command: 'npx vite --host 127.0.0.1 --port 5175 --strictPort',
        url: 'http://127.0.0.1:5175', reuseExistingServer: true,
    },
});


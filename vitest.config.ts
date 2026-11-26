import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import packageJson from './package.json';

export default defineConfig({
    plugins: [react()],
    define: {
        // Mirror vite.config.ts so modules that read the build-time app version
        // (src/version.ts) work under vitest too. Without this, importing
        // src/version.ts throws `__APP_VERSION__ is not defined` in tests.
        __APP_VERSION__: JSON.stringify(packageJson.version),
    },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['src/test/setup.ts'],
        include: ['src/**/*.{test,spec}.{js,ts,tsx,jsx}', 'server/__tests__/**/*.test.{js,ts}'],
    },
});

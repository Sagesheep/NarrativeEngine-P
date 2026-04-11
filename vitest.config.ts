import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['src/test/setup.ts'],
        include: ['src/**/*.{test,spec}.{js,ts,tsx,jsx}', 'server/__tests__/**/*.test.{js,ts}'],
    },
});

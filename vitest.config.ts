import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'jsdom',
        include: ['src/**/*.{test,spec}.{js,ts,tsx,jsx}', 'server/__tests__/**/*.test.{js,ts}'],
    },
});

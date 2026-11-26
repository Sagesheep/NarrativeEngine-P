import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';
import packageJson from '../../package.json';

// Experiment-only config: kept out of the main suite (vitest.config.ts includes src/ and
// server/__tests__ only), because these harnesses read and write real campaign files.
export default defineConfig({
    root: fileURLToPath(new URL('../..', import.meta.url)),
    define: {
        __APP_VERSION__: JSON.stringify(packageJson.version),
    },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['src/test/setup.ts'],
        include: ['scripts/turn-prep-experiment/**/*.test.ts'],
    },
});

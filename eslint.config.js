import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `npm run lint` reported 346 problems, of which 193 were in code this app
  // does not build: the separate mobile app, a stale detached git worktree,
  // and Tiled tileset XML that happens to use the `.tsx` extension. Output
  // nobody can act on is output nobody reads, so scope it to this app.
  globalIgnores([
    'dist',
    'build-output',
    'mobile/**',          // separate application, linted by its own config
    '.claude/**',         // agent worktrees and scratch checkouts
    'public/assets/**',   // Tiled tilesets: XML with a .tsx extension, not React
    'public/bundled-mods/**', // shipped mod bundles, authored as plain JS
    'server.bundle.cjs',  // generated
    'TRASH/**',
    'Upgrade/**',         // plans and archived notes, not built
    'docs/**',
    'test-results/**',
    'graphify-out/**',
    'src/graphify-out/**',
    'server/graphify-out/**',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])

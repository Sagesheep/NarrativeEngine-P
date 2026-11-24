# CLAUDE.md — Narrative Engine Desktop (mainApp)

## Local AI Context Navigation
> [!IMPORTANT]
> This project has a comprehensive system map and blast radius assessment in [`AI_CODEBASE_MAP.md`](file:///d:/Games/AI%20DM%20Project/Automated_system/mainApp/AI_CODEBASE_MAP.md).
> - **Always read `AI_CODEBASE_MAP.md` first** before starting any coding task to understand module boundaries, data flows, and dependencies.
> - Refer to the **Blast Radius & Downstream Impact Matrix** in it to avoid regression failures when editing core store slices, database utilities, or orchestrator services.

### Graphify Visual Dependency Graphs
- Visual dependency reports exist at `d:\Games\AI DM Project\Automated_system\graphify-out\GRAPH_REPORT.md`.
- After modifying imports or file configurations, run:
  ```bash
  node scripts/patch-graph-imports.mjs
  ```
  This will parse the codebase imports, rebuild the dependency map, and update `graphify-out/graph.json` and the interactive visual file `graphify-out/graph.html`.

---

## Build, Test & Run Commands
- **Start App (Frontend + Server concurrently)**: `npm run dev` (starts server on port 3001, Vite frontend on port 5173)
- **Start Backend Server only**: `node server.js`
- **Build Frontend Assets**: `npm run build`
- **Lint Codebase**: `npm run lint` or `npx eslint .`
- **Run Tests**: `npm run test` or `npx vitest`
- **Run Tests with Coverage**: `npm run test:coverage`

---

## Coding Standards & Architecture
- **Language**: TypeScript (strict mode) for frontend, Node.js ES Modules (ESM) for backend.
- **State Management**: Central Zustand store (`src/store/useAppStore.ts`) combining slices for settings, campaigns, chat, and UI. Avoid ad-hoc state managers.
- **Turn Orchestration**: The main game loop flows through `src/services/turn/turnOrchestrator.ts` (`runTurn()`). Swiping and swipe-commit lifecycles are staged in `src/services/turn/pendingCommit.ts`.
- **Database & Storage**: JSON file store per campaign in `data/`, indexed by SQLite vector database (`data/embeddings.db`) using `sqlite-vec` for local semantic recall.
- **API keys**: stored only in the browser (IndexedDB `nn_settings`), encrypted with AES-GCM via `src/services/infrastructure/settingsCrypto.ts`. The server blanks every `apiKey` before writing `data/settings.json` (`stripApiKeys` in `server/routes/settings.js`). There is no server-side key vault.

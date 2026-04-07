# Phase 2 Implementation Complete

## Summary

Phase 2 - Chapter Lifecycle: Auto-Seal + Summary Generation has been implemented.

### Files Modified/Created:

1. **src/types/index.ts**
   - Added `_lastSeenSessionId?: string` to ArchiveChapter type

2. **src/services/archiveChapterEngine.ts** (NEW)
   - `shouldAutoSeal()` - detects when chapter should be sealed
   - `extractSessionIds()` - parses SESSION_ID from header index
   - `sealChapter()` - executes seal and creates new open chapter
   - `updateChapterSessionId()` - helper for session tracking

3. **src/services/saveFileEngine.ts**
   - Added `generateChapterSummary()` - async LLM summary generation
   - Added `buildChapterSummaryPrompt()` - structured JSON prompt
   - Added `parseChapterSummaryOutput()` - robust parsing
   - Added `truncateScenesToBudget()` - token budget management with js-tiktoken

4. **server.js**
   - Added `POST /api/campaigns/:id/archive/chapters/seal` endpoint for manual seal

5. **src/services/apiClient.ts**
   - Added `api.chapters.seal()` method

6. **src/components/ChatArea.tsx**
   - Added auto-seal check after each turn
   - Added `checkAndSealChapter()` function
   - Added `handleSealChapter()` function with confirmation dialog
   - Added `generateChapterSummaryAsync()` fire-and-forget function
   - Added "Seal" button in Archive macro bar
   - Imports: shouldAutoSeal, generateChapterSummary

7. **src/services/__tests__/archiveChapterEngine.test.ts** (NEW)
   - Unit tests for extractSessionIds
   - Unit tests for shouldAutoSeal
   - Unit tests for sealChapter
   - Unit tests for updateChapterSessionId

8. **vitest.config.ts** (NEW)
   - Vitest configuration

9. **package.json**
   - Added vitest, jsdom, @vitest/ui to devDependencies
   - Added "test": "vitest" script

## Next Steps

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run tests:
   ```bash
   npm test
   ```

3. Test the implementation:
   - Start the app: `npm run dev`
   - Play through 25 scenes to trigger auto-seal
   - Or click "Seal" button to manually seal a chapter
   - Check console logs for seal events and summary generation

## Decisions Made

| Decision | Choice |
|----------|--------|
| Session ID tracking | Added `_lastSeenSessionId` field to ArchiveChapter |
| Auto-seal threshold | 25 scenes (configurable via `AUTO_SEAL_SCENE_THRESHOLD`) |
| Summary endpoint | Uses existing `summarizerAI` from active preset |
| Token budget | 8000 tokens, truncates oldest scenes first |
| Store update | Refreshes chapters from server after seal (source of truth) |
| Summary failure | Shows toast error, chapter remains sealed with empty summary |
| Manual seal UI | "Seal" button in Archive macro bar with confirmation dialog |

## Known Limitations

1. Tests require `npm install` to run (vitest not yet installed)
2. Session boundary detection only works when header index contains SESSION_ID entries
3. Summary generation is fire-and-forget; failed summaries need manual retry via UI (Phase 5)

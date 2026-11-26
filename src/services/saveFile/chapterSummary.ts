import type { ArchiveChapter, ProviderConfig, EndpointConfig } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { extractJson } from '../infrastructure/jsonExtract';
import { llmCall } from '../../utils/llmCall';
import { truncateScenesToBudget, CHAPTER_SUMMARY_TOKEN_BUDGET } from './shared';
import { renderPrompt } from '../prompts/promptRegistry';

// ─── Chapter Summary Generator ───

export type ChapterSummaryOutput = {
    title: string;
    // WO-06: optional synopsis/title-variant fields. Ride the existing
    // ...result.summary spread into the chapters PATCH (Option A placement).
    // Missing → undefined silently (old-output + manual-summary compat).
    // Present-but-empty/wrong-type → undefined with one compact warning.
    synopsis?: string;
    abstractTitle?: string;
    literalTitle?: string;
    summary: string;
    keywords: string[];
    npcs: string[];
    majorEvents: string[];
    unresolvedThreads: string[];
    tone: string;
    themes: string[];
};

function buildChapterSummaryPrompt(
    chapter: ArchiveChapter,
    scenes: { sceneId: string; content: string }[],
    headerIndex: string
): string {
    const truncated = truncateScenesToBudget(scenes, CHAPTER_SUMMARY_TOKEN_BUDGET);
    const sceneContent = truncated.map(s => `--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n\n');
    const sceneRangeStr = `${chapter.sceneRange[0]} to ${chapter.sceneRange[1]}`;

    return renderPrompt('memory.chapter-summary', {
        title: chapter.title || 'Untitled',
        sceneRange: sceneRangeStr,
        sceneCount: chapter.sceneCount,
        headerIndex: headerIndex.slice(0, 2000),
        scenes: sceneContent,
    });
}

/**
 * Extract JSON from LLM output, handling markdown fences and common errors.
 */
export function parseChapterSummaryOutput(raw: string): ChapterSummaryOutput | null {
    const cleaned = extractJson(raw.trim());

    try {
        const parsed = JSON.parse(cleaned);

        // Validate required fields
        const required: (keyof ChapterSummaryOutput)[] = [
            'title', 'summary', 'keywords', 'npcs',
            'majorEvents', 'unresolvedThreads', 'tone', 'themes'
        ];

        for (const field of required) {
            if (!(field in parsed)) {
                console.warn(`[ChapterSummary] Missing field: ${field}`);
                parsed[field] = field === 'summary' || field === 'tone' ? '' : [];
            }
        }

        if (Array.isArray(parsed.summary)) parsed.summary = parsed.summary.join('\n');
        if (Array.isArray(parsed.tone)) parsed.tone = parsed.tone.join(', ');

        // WO-06: validate the three optional synopsis/title-variant fields independently.
        // Missing → stay undefined silently (old-output and manual-summary compatibility).
        // Present but empty or wrong type → coerce to undefined with one compact warning.
        // Present and a non-empty string → trim and preserve.
        const OPTIONAL_STRING_FIELDS: (keyof ChapterSummaryOutput)[] = [
            'synopsis', 'abstractTitle', 'literalTitle',
        ];
        for (const field of OPTIONAL_STRING_FIELDS) {
            if (!(field in parsed)) continue;
            const v = parsed[field];
            if (typeof v !== 'string' || v.trim() === '') {
                console.warn(`[ChapterSummary] Optional field "${field}" present but empty/wrong-type — coerced to undefined`);
                delete parsed[field];
                continue;
            }
            parsed[field] = v.trim();
        }

        return parsed as ChapterSummaryOutput;
    } catch (e) {
        console.error('[ChapterSummary] Failed to parse JSON:', e);
        return null;
    }
}

export async function generateChapterSummary(
    provider: ProviderConfig | EndpointConfig,
    chapter: ArchiveChapter,
    scenes: { sceneId: string; content: string }[],
    headerIndex: string,
    maxRetries = 1
): Promise<ChapterSummaryOutput | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = attempt === 0
            ? buildChapterSummaryPrompt(chapter, scenes, headerIndex)
            : buildChapterSummaryPrompt(chapter, scenes, headerIndex) +
            '\n\nPREVIOUS ATTEMPT FAILED. Output ONLY valid JSON with all required fields.';

        console.log(`[SaveFileEngine] Generating Chapter Summary... (Attempt ${attempt + 1})`, {
            chapterId: chapter.chapterId,
            sceneCount: scenes.length,
            promptTokens: countTokens(prompt)
        });

        const output = await llmCall(provider, prompt, { priority: 'low' });
        const result = parseChapterSummaryOutput(output);

        if (result) {
            return result;
        }
        console.warn(`[SaveFileEngine] Chapter Summary attempt ${attempt + 1} failed parsing`);
    }

    return null;
}

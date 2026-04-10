/**
 * LLM proxy functions extracted from server.js.
 * Uses global fetch — no other external dependencies.
 */

export const TIMELINE_PREDICATES_SERVER = [
    'status', 'located_in', 'holds', 'allied_with', 'enemy_of',
    'killed_by', 'controls', 'relationship_to', 'seeks', 'knows_about',
    'destroyed', 'misc',
];

/**
 * Shared fetch-retry helper.
 * Returns the raw matched JSON string from the response, or null on failure.
 */
async function callLLMWithRetry(prompt, config, { retries = 1, timeoutMs = 6000, jsonPattern = /\{[\s\S]*\}/ } = {}) {
    let attempts = 0;
    while (attempts < retries) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            const response = await fetch(`${config.endpoint}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify({
                    model: config.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.1,
                    stream: false,
                }),
                signal: controller.signal,
            });

            clearTimeout(timer);
            if (!response.ok) { attempts++; continue; }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content || '';

            const jsonMatch = content.match(jsonPattern);
            if (!jsonMatch) { attempts++; continue; }

            return jsonMatch[0];
        } catch (err) {
            console.warn(`[LLM] attempt ${attempts + 1} failed:`, err.message);
            attempts++;
        }
    }
    return null;
}

export async function extractWitnessesLLM(npcNames, userContent, assistantContent, utilityConfig) {
    if (!utilityConfig?.endpoint) return null;

    const combinedText = `${userContent}\n${assistantContent}`.slice(0, 2000);

    const prompt = `Given this RPG scene transcript and a list of NPCs mentioned, classify each NPC as either a WITNESS (physically present, actively participating, speaking, or directly addressed) or merely MENTIONED (talked about but not present).

NPCs to classify: ${JSON.stringify(npcNames)}

Scene:
${combinedText}

Respond ONLY with valid JSON:
{
  "witnesses": ["NPCs who were physically present/active"],
  "mentioned": ["NPCs who were only talked about"]
}`;

    const raw = await callLLMWithRetry(prompt, utilityConfig, {
        retries: 1,
        timeoutMs: 5000,
        jsonPattern: /\{[\s\S]*\}/,
    });
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.witnesses) && Array.isArray(parsed.mentioned)) {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

export async function extractTimelineEventsLLM(entityNames, text, sceneId, chapterId, utilityConfig) {
    if (!utilityConfig?.endpoint) return null;

    const truncatedText = text.slice(0, 3000);

    const prompt = `Extract world-state changes from this RPG scene as timeline events.

Known entities (use canonical names): ${JSON.stringify(entityNames)}

Allowed predicates: ${TIMELINE_PREDICATES_SERVER.join(', ')}

Scene:
${truncatedText}

Rules:
- Only extract clear, explicit state changes from the text
- Use canonical entity names from the known entities list when possible
- predicate must be exactly one from the allowed list; use "misc" if none fit
- importance 1-10 (10 = death/major plot, 1 = minor detail)
- summary: one human-readable sentence

Respond ONLY with a JSON array:
[
  {"subject": "Name", "predicate": "killed_by", "object": "Goblin King", "summary": "Aldric was slain by the Goblin King", "importance": 10}
]

If no state changes, return: []`;

    const raw = await callLLMWithRetry(prompt, utilityConfig, {
        retries: 2,
        timeoutMs: 6000,
        jsonPattern: /\[[\s\S]*\]/,
    });
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;

        return parsed.filter(e =>
            e.subject && e.predicate && e.object && typeof e.importance === 'number'
        ).map(e => ({
            sceneId,
            chapterId,
            subject: e.subject,
            predicate: TIMELINE_PREDICATES_SERVER.includes(e.predicate) ? e.predicate : 'misc',
            object: e.object,
            summary: e.summary || `${e.subject} ${e.predicate} ${e.object}`,
            importance: Math.min(10, Math.max(1, e.importance)),
            source: 'llm',
        }));
    } catch {
        return null;
    }
}

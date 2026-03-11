import type {
    ChatMessage,
    EndpointConfig,
    ProviderConfig,
    QuestEntry,
    QuestExtractionResult,
    QuestObjective,
    QuestStatus,
    QuestChange,
} from '../types';

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function extractJson(text: string): string {
    let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const markdownMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (markdownMatch) {
        clean = markdownMatch[1].trim();
    }

    const firstObj = clean.indexOf('{');
    const firstArr = clean.indexOf('[');
    const start = firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
    if (start === -1) return clean;

    const lastObj = clean.lastIndexOf('}');
    const lastArr = clean.lastIndexOf(']');
    const end = Math.max(lastObj, lastArr);
    if (end === -1 || end <= start) return clean;

    return clean.slice(start, end + 1).trim();
}

async function llmCall(provider: EndpointConfig | ProviderConfig, prompt: string): Promise<string> {
    const url = `${provider.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: provider.modelName,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            temperature: 0.2,
        }),
    });

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`QuestTracker API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
}

function normalizeStatus(status: string | undefined): QuestStatus {
    const value = (status || 'active').toLowerCase();
    switch (value) {
        case 'available':
        case 'active':
        case 'blocked':
        case 'completed':
        case 'failed':
        case 'abandoned':
            return value;
        default:
            return 'active';
    }
}

function normalizeObjective(objective: Partial<QuestObjective>, fallbackText: string): QuestObjective {
    const progress = typeof objective.progress === 'number' ? objective.progress : undefined;
    const target = typeof objective.target === 'number' ? objective.target : undefined;
    const done = typeof objective.done === 'boolean'
        ? objective.done
        : typeof progress === 'number' && typeof target === 'number'
            ? progress >= target
            : false;

    return {
        id: objective.id || uid(),
        text: (objective.text || fallbackText).trim(),
        done,
        progress,
        target,
    };
}

function appendNote(quest: QuestEntry, text: string, source: 'ai' | 'user' | 'system' = 'ai') {
    const trimmed = text.trim();
    if (!trimmed) return;
    quest.notes.push({
        id: uid(),
        text: trimmed,
        timestamp: Date.now(),
        source,
    });
}

function findQuestIndex(quests: QuestEntry[], questId?: string, title?: string): number {
    if (questId) {
        const byId = quests.findIndex((quest) => quest.id === questId);
        if (byId !== -1) return byId;
    }

    if (!title) return -1;
    const needle = title.trim().toLowerCase();
    return quests.findIndex((quest) => quest.title.trim().toLowerCase() === needle);
}

export function formatQuestDigest(quests: QuestEntry[] = [], includeCompleted = false): string {
    const filtered = quests.filter((quest) => includeCompleted || !['completed', 'failed', 'abandoned'].includes(quest.status));
    if (filtered.length === 0) return '';

    const lines = filtered.map((quest) => {
        const objectiveSummary = quest.objectives.length > 0
            ? quest.objectives.map((objective) => {
                if (typeof objective.progress === 'number' && typeof objective.target === 'number') {
                    return `${objective.text} (${objective.progress}/${objective.target})`;
                }
                return objective.done ? `${objective.text} (done)` : objective.text;
            }).join(' | ')
            : 'No objectives logged';

        return `- [${quest.status}][${quest.category}] ${quest.title} — ${quest.summary} Objectives: ${objectiveSummary}`;
    });

    return ['[QUEST LOG]', ...lines, '[END QUEST LOG]'].join('\n');
}

export function buildQuestExtractionPrompt(recentMessages: ChatMessage[], existingQuests: QuestEntry[]): string {
    const recentScene = recentMessages
        .slice(-6)
        .map((message) => `[${message.role.toUpperCase()}]: ${message.content}`)
        .join('\n\n');

    const questDigest = existingQuests.length > 0
        ? existingQuests.map((quest) => {
            const objectiveDigest = quest.objectives.length > 0
                ? quest.objectives.map((objective) => {
                    if (typeof objective.progress === 'number' && typeof objective.target === 'number') {
                        return `${objective.id}: ${objective.text} (${objective.progress}/${objective.target})`;
                    }
                    return `${objective.id}: ${objective.text}${objective.done ? ' [done]' : ''}`;
                }).join(' | ')
                : 'none';

            return `- ${quest.id} | ${quest.status} | ${quest.category} | ${quest.title} | ${quest.summary} | objectives: ${objectiveDigest}`;
        }).join('\n')
        : '[none]';

    return [
        'You are a quest-state extractor for a TTRPG session.',
        '',
        'Your job:',
        '- Decide whether the latest scene created or changed a trackable quest.',
        '- Output either NO_CHANGE or strict JSON.',
        '- Be conservative. If the evidence is weak, return NO_CHANGE.',
        '',
        'You must NOT:',
        '- invent lore',
        '- invent objectives',
        '- infer hidden motives',
        '- rewrite the whole quest log',
        '- output prose outside the allowed format',
        '',
        'A quest-worthy change exists only if at least one is explicit in the recent scene:',
        '- a character gives a concrete task, request, contract, or mission',
        '- the player explicitly accepts or begins pursuing a task',
        '- measurable progress occurs on an existing quest',
        '- an existing quest is clearly completed, failed, blocked, or abandoned',
        '',
        'Recent scene:',
        recentScene || '[none]',
        '',
        'Current quest digest:',
        questDigest,
        '',
        'Output rules:',
        '- If no strong quest change is supported, output exactly: NO_CHANGE',
        '- Otherwise output valid JSON only with this shape:',
        '{',
        '  "action": "APPLY",',
        '  "changes": [',
        '    {',
        '      "type": "create_quest | update_progress | set_status | add_note",',
        '      "questId": "existing quest id or null for new quest",',
        '      "title": "short title or null",',
        '      "summary": "one-line factual summary or null",',
        '      "status": "available | active | blocked | completed | failed | abandoned | null",',
        '      "category": "main | side | errand | faction | investigation | hunt | social | survival | hidden | null",',
        '      "objectives": [',
        '        {',
        '          "id": "objective id or null",',
        '          "text": "objective text",',
        '          "done": false,',
        '          "progress": 0,',
        '          "target": 0',
        '        }',
        '      ],',
        '      "note": "short factual progress note or null",',
        '      "evidence": "short quote or paraphrase from recent scene"',
        '    }',
        '  ]',
        '}',
        '',
        'Constraints:',
        '- Max 3 changes.',
        '- Prefer updating an existing quest over creating a duplicate.',
        '- Only include fields needed for that change.',
        '- For create_quest, title and summary are required.',
        '- For update_progress, reference an existing quest if possible.',
        '- For set_status, only use a status clearly supported by the scene.',
        '- If uncertain between create and NO_CHANGE, choose NO_CHANGE.',
    ].join('\n');
}

function normalizeQuestChanges(raw: unknown): QuestExtractionResult {
    if (!raw || typeof raw !== 'object') {
        return { action: 'NO_CHANGE' };
    }

    const parsed = raw as { action?: unknown; changes?: unknown[] };
    if (parsed.action !== 'APPLY' || !Array.isArray(parsed.changes)) {
        return { action: 'NO_CHANGE' };
    }

    const changes = parsed.changes
        .slice(0, 3)
        .map((change): QuestChange | null => {
            if (!change || typeof change !== 'object') return null;
            const value = change as Record<string, unknown>;
            const type = typeof value.type === 'string' ? value.type : '';
            if (!['create_quest', 'update_progress', 'set_status', 'add_note'].includes(type)) return null;
            return {
                type: type as QuestChange['type'],
                questId: typeof value.questId === 'string' ? value.questId : undefined,
                title: typeof value.title === 'string' ? value.title : undefined,
                summary: typeof value.summary === 'string' ? value.summary : undefined,
                status: typeof value.status === 'string' ? normalizeStatus(value.status) : undefined,
                category: typeof value.category === 'string' ? value.category as QuestEntry['category'] : undefined,
                objectives: Array.isArray(value.objectives)
                    ? value.objectives.map((objective) => normalizeObjective((objective || {}) as Partial<QuestObjective>, typeof (objective as { text?: unknown })?.text === 'string' ? (objective as { text: string }).text : 'Objective'))
                    : undefined,
                note: typeof value.note === 'string' ? value.note : undefined,
                evidence: typeof value.evidence === 'string' ? value.evidence : '',
            };
        })
        .filter((change): change is QuestChange => !!change);

    if (changes.length === 0) {
        return { action: 'NO_CHANGE' };
    }

    return { action: 'APPLY', changes };
}

export async function extractQuestChanges(
    provider: EndpointConfig | ProviderConfig,
    recentMessages: ChatMessage[],
    existingQuests: QuestEntry[] = []
): Promise<QuestExtractionResult> {
    if (recentMessages.length === 0) {
        return { action: 'NO_CHANGE' };
    }

    const prompt = buildQuestExtractionPrompt(recentMessages, existingQuests);
    const raw = await llmCall(provider, prompt);
    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'NO_CHANGE') {
        return { action: 'NO_CHANGE' };
    }

    try {
        const parsed = JSON.parse(extractJson(trimmed));
        return normalizeQuestChanges(parsed);
    } catch (error) {
        console.warn('[QuestTracker] Failed to parse extractor output:', error);
        return { action: 'NO_CHANGE' };
    }
}

export function applyQuestChanges(
    existingQuests: QuestEntry[] = [],
    result: QuestExtractionResult,
    lastTouchedSceneId?: string
): QuestEntry[] {
    if (result.action !== 'APPLY') {
        return existingQuests;
    }

    const next = existingQuests.map((quest) => ({
        ...quest,
        objectives: quest.objectives.map((objective) => ({ ...objective })),
        notes: quest.notes.map((note) => ({ ...note })),
        actors: [...quest.actors],
        locations: [...quest.locations],
        tags: [...quest.tags],
    }));

    for (const change of result.changes) {
        if (change.type === 'create_quest') {
            if (!change.title || !change.summary) continue;
            const existingIndex = findQuestIndex(next, change.questId, change.title);
            if (existingIndex !== -1) {
                const existing = next[existingIndex];
                existing.summary = change.summary || existing.summary;
                existing.status = change.status || existing.status;
                existing.updatedAt = Date.now();
                existing.lastTouchedSceneId = lastTouchedSceneId || existing.lastTouchedSceneId;
                if (change.note) appendNote(existing, change.note);
                continue;
            }

            const now = Date.now();
            const objectives = (change.objectives && change.objectives.length > 0)
                ? change.objectives.map((objective) => normalizeObjective(objective, objective.text))
                : [normalizeObjective({ text: change.summary }, change.summary)];

            const quest: QuestEntry = {
                id: uid(),
                title: change.title.trim(),
                summary: change.summary.trim(),
                status: change.status || 'active',
                category: change.category || 'side',
                objectives,
                actors: [],
                locations: [],
                tags: [],
                notes: [],
                createdAt: now,
                updatedAt: now,
                lastTouchedSceneId,
            };
            if (change.note) appendNote(quest, change.note);
            appendNote(quest, change.evidence, 'system');
            next.push(quest);
            continue;
        }

        const questIndex = findQuestIndex(next, change.questId, change.title);
        if (questIndex === -1) continue;
        const quest = next[questIndex];
        quest.updatedAt = Date.now();
        quest.lastTouchedSceneId = lastTouchedSceneId || quest.lastTouchedSceneId;

        if (change.type === 'set_status' && change.status) {
            quest.status = change.status;
            if (change.note) appendNote(quest, change.note);
            appendNote(quest, change.evidence, 'system');
            continue;
        }

        if (change.type === 'add_note') {
            if (change.note) appendNote(quest, change.note);
            appendNote(quest, change.evidence, 'system');
            continue;
        }

        if (change.type === 'update_progress') {
            const incoming = change.objectives && change.objectives.length > 0 ? change.objectives[0] : undefined;
            const objectiveIndex = incoming?.id
                ? quest.objectives.findIndex((objective) => objective.id === incoming.id)
                : incoming?.text
                    ? quest.objectives.findIndex((objective) => objective.text.trim().toLowerCase() === incoming.text.trim().toLowerCase())
                    : 0;

            if (objectiveIndex === -1 && incoming) {
                quest.objectives.push(normalizeObjective(incoming, incoming.text));
            } else {
                const index = objectiveIndex >= 0 ? objectiveIndex : 0;
                if (!quest.objectives[index]) {
                    quest.objectives[index] = normalizeObjective(incoming || { text: quest.summary }, quest.summary);
                }
                if (incoming) {
                    const objective = quest.objectives[index];
                    objective.text = incoming.text || objective.text;
                    if (typeof incoming.progress === 'number') objective.progress = incoming.progress;
                    if (typeof incoming.target === 'number') objective.target = incoming.target;
                    if (typeof incoming.done === 'boolean') {
                        objective.done = incoming.done;
                    } else if (typeof objective.progress === 'number' && typeof objective.target === 'number') {
                        objective.done = objective.progress >= objective.target;
                    }
                }
            }

            if (change.note) appendNote(quest, change.note);
            appendNote(quest, change.evidence, 'system');
        }
    }

    return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

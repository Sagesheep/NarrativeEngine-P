const SYSTEM_PROMPT = `You are preparing an illustration brief for a roleplaying scene text-to-image generator.

CRITICAL INSTRUCTIONS:
1. The positivePrompt MUST describe visual subjects, physical environment, lighting, clothing, camera framing, and art style in pure visual terms.
2. NEVER copy or include raw story paragraphs, dialogue quotes, or text sentences inside positivePrompt. Text-to-image models (like Flux/SDXL) take literal text as typography to draw onto the canvas!
3. Convert all character actions and dialogue into physical visual poses and facial expressions.
4. Use only facts supplied in the scene context. Do not invent unstated characters or locations.
5. Return valid JSON only.

JSON Format:
{
  "focus": "Brief 1-sentence description of the visual focus",
  "sceneContextSummary": "1-2 sentence summary of active setting & characters present",
  "positivePrompt": "Pure visual description of physical subjects, environment, lighting, composition for text-to-image generator",
  "negativePrompt": "text, words, writing, font, quote, letters, typography, handwriting, captions, watermark, logo, signature, low quality",
  "style": "Cinematic illustration",
  "framing": "Wide scene",
  "aspectRatio": "16:9",
  "warnings": []
}`;

function extractJson(text) {
    if (!text) return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

function sanitizeAspect(aspect) {
    if (aspect === '16:9' || aspect === '9:16' || aspect === '1:1') return aspect;
    return '16:9';
}

function buildFallbackPackage(contextInput) {
    const loc = contextInput.activeScene?.location || 'a roleplaying scene';
    const characters = contextInput.presentCharacters?.length ? contextInput.presentCharacters.join(', ') : 'characters';

    // Strip quotation marks and raw prose to construct a clean visual description
    const cleanProse = (contextInput.selectedText || '')
        .replace(/["'“”]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    
    const focusSnippet = cleanProse.length > 80 ? cleanProse.slice(0, 77) + '...' : cleanProse;

    return {
        focus: `Scene depicting: ${focusSnippet}`,
        sceneContextSummary: `Set in ${loc}.`,
        positivePrompt: `High quality cinematic illustration of ${characters} in ${loc}, scene moment: ${cleanProse}. Atmospheric lighting, detailed environment, 8k resolution, concept art.`,
        negativePrompt: 'text, words, writing, font, quote, letters, typography, handwriting, captions, watermark, logo, signature, low quality',
        style: contextInput.campaignVisualStyle || 'Cinematic illustration',
        framing: 'Wide scene',
        aspectRatio: '16:9',
        warnings: ['Fallback prompt generated from selection.'],
    };
}

export async function composeSceneImagePrompt({ contextInput, llmConfig }) {
    if (!contextInput || !contextInput.selectedText) {
        throw new Error('Missing selectedText in contextInput');
    }

    if (!llmConfig || !llmConfig.endpoint) {
        return buildFallbackPackage(contextInput);
    }

    const narrativeBlock = (contextInput.recentNarrative || [])
        .slice(-3)
        .map((m, i) => `Excerpt ${i + 1}: ${m.text}`)
        .join('\n');

    const userPrompt = `Selected Moment: "${contextInput.selectedText}"
Active Scene Location: ${contextInput.activeScene?.location || 'Unspecified'}
Time/Weather: ${[contextInput.activeScene?.time, contextInput.activeScene?.weather].filter(Boolean).join(', ') || 'Unspecified'}
Present Characters: ${contextInput.presentCharacters?.join(', ') || 'None'}
Preceding Narrative Context:
${narrativeBlock || 'None'}
Campaign Visual Style: ${contextInput.campaignVisualStyle || 'Cinematic illustration'}`;

    const payload = {
        model: llmConfig.modelName || 'gpt-4o-mini',
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
    };

    const headers = { 'Content-Type': 'application/json' };
    if (llmConfig.apiKey) {
        headers['Authorization'] = `Bearer ${llmConfig.apiKey}`;
    }

    let url = llmConfig.endpoint.replace(/\/+$/, '');
    if (!url.endsWith('/chat/completions')) {
        url = `${url}/chat/completions`;
    }

    let rawOutput = '';
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
        if (res.ok) {
            const data = await res.json();
            rawOutput = data.choices?.[0]?.message?.content || '';
        }
    } catch (err) {
        console.warn('[SceneImage Composer] LLM fetch failed, using fallback:', err.message);
        return buildFallbackPackage(contextInput);
    }

    let parsed = extractJson(rawOutput);

    if (!parsed || !parsed.positivePrompt) {
        console.warn('[SceneImage Composer] Invalid LLM output, falling back to template');
        return buildFallbackPackage(contextInput);
    }

    return {
        focus: String(parsed.focus || contextInput.selectedText),
        sceneContextSummary: String(parsed.sceneContextSummary || ''),
        positivePrompt: String(parsed.positivePrompt),
        negativePrompt: String(parsed.negativePrompt || 'text, words, writing, font, quote, letters, typography, handwriting, captions, watermark, logo, signature, low quality'),
        style: String(parsed.style || 'Cinematic illustration'),
        framing: parsed.framing ? String(parsed.framing) : 'Wide scene',
        aspectRatio: sanitizeAspect(parsed.aspectRatio),
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    };
}

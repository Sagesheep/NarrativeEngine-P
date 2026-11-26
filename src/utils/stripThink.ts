/** Strip <think>...</think> reasoning blocks and markdown fences from LLM output */
export function stripThinkTags(raw: string): string {
    let clean = raw.replace(/<think[\s\S]*?<\/think\s*>/gi, '');
    const fence = clean.match(/```(?:\w+)?\s*([\s\S]*?)```/);
    if (fence) clean = fence[1];
    return clean.trim();
}

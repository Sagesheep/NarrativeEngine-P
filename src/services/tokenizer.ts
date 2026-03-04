import { getEncoding } from 'js-tiktoken';

const encoder = getEncoding('cl100k_base');

/**
 * Accurate token count using cl100k_base BPE tokenizer.
 * This is highly accurate for DeepSeek, OpenAI, and Anthropic models compared to length heuristics.
 */
export function countTokens(text: string): number {
    if (!text) return 0;
    return encoder.encode(text).length;
}

// Barrel file — re-exports from focused modules for backward compatibility.
// All existing imports like `import { buildPayload, sendMessage } from './chatEngine'` continue to work.

export { buildPayload } from './payload/payloadBuilder';
export { extractJson } from './infrastructure/jsonExtract';
export { sendMessage, testConnection } from './llm/llmService';
export type { OpenAIMessage } from './llm/llmService';
export { generateNPCProfile, updateExistingNPCs, generateNPCPortrait, backfillNPCDrives } from './npcGeneration';
export { populateEngineTags } from './turn/tagGeneration';

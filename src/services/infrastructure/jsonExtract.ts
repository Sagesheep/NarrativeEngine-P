// JSON extraction lives in @narrative/engine (shared with the mobile app).
// The engine version is a merge: this app's array-root support, truncation
// recovery, and repairJson PLUS mobile's unclosed-<think> handling. One
// deliberate fix over the old desktop version: repair only runs on text that
// fails JSON.parse, so valid JSON (e.g. "//" inside URL string values) is
// never altered. Re-exported here so existing imports keep working.
export { extractJson, extractJsonRobust } from '@narrative/engine';

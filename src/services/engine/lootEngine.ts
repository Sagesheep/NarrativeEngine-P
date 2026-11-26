// The loot walker lives in @narrative/engine (shared with the mobile app).
// Re-exported here so existing imports keep working. Loot TYPES stay in
// src/types (the app's source of truth); they are structural twins of the
// engine's own loot types.
export { resolveLootDrop } from '@narrative/engine';

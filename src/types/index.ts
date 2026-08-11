// ─── Type barrel — re-exports everything so existing import sites are unchanged ───
// import { X } from '../types' continues to work for all X.

export * from './llm';
export * from './character';
export * from './lore';
export * from './campaign';
export * from './archive';
export * from './divergence';
export * from './map';
export * from './gamecontext';
export * from './arc';
export * from './loot';
export * from './location';
export * from './sceneImage';
// Phase 8.5 — `./enemy` is gone. The seventeen enemy types left core with the
// subsystem; the `enemies` mod holds the shape in its own `validator.js`.

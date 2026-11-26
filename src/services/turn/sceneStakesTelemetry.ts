import { useSyncExternalStore } from 'react';

/**
 * Scene-stakes fallback telemetry: counts how often the GM omitted the
 * [[SCENE_STAKES]] tag and the cheap in-engine classifier had to fire.
 *
 * Ported from mobileApp/src/services/llm/sceneStakesTelemetry.ts during the
 * settings tab port. mainApp's sceneStakesTag.ts previously stubbed the
 * recorder as a no-op; this module makes it observable in the Debug tab.
 */

const STORAGE_KEY = 'sceneStakesFallback.v1';

let count: number = load();
const listeners = new Set<() => void>();

function load(): number {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? (JSON.parse(raw) as number) : 0;
    } catch {
        return 0;
    }
}

function persist() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(count));
    } catch { /* best-effort */ }
}

function emit() {
    for (const l of listeners) l();
}

export function recordSceneStakesFallback(): void {
    count += 1;
    persist();
    emit();
}

export function getSceneStakesFallbackCount(): number {
    return count;
}

export function resetSceneStakesFallbackCount(): void {
    count = 0;
    persist();
    emit();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

let snapshotRef = count;
listeners.add(() => { snapshotRef = count; });

export function useSceneStakesFallbackCount(): number {
    return useSyncExternalStore(subscribe, () => snapshotRef, () => snapshotRef);
}
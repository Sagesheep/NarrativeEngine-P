export function safeSceneNum(sceneRef: string): number {
    const n = parseInt(sceneRef, 10);
    return isNaN(n) ? 0 : n;
}

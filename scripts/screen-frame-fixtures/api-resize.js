// P5-18 §5 — the host clamps a proposed height.
export default async function () {
    const response = await globalThis.__screenApi.request({ capability: 'resize', height: 100000 });
    parent.postMessage({ __screenFixture: 'api-resize.js', requested: 100000, applied: response.height }, '*');
}

// P5-18 §5 — undeclared capabilities are denied and faulted.
export default async function () {
    try {
        await globalThis.__screenApi.request({ capability: 'clipboard.read' });
    } catch {}
}

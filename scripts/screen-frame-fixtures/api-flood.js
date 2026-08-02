// P5-18 §5 — the per-mount inbound message cap is 1000.
export default function () {
    for (let index = 0; index < 1001; index += 1) {
        globalThis.__screenApi.request({ capability: 'theme' }).catch(() => {});
    }
}

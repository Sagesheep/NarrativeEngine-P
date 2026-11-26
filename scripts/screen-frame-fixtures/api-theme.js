// P5-18 §5 — theme arrives as token data, never CSS or class names.
export default async function () {
    const requested = await globalThis.__screenApi.request({ capability: 'theme' });
    const initial = globalThis.__screenTheme;
    const tokenSource = requested || initial;
    parent.postMessage({
        __screenFixture: 'api-theme.js',
        hasTokenValues: Boolean(tokenSource && tokenSource.colors?.background && tokenSource.fontSizes?.body && tokenSource.radii?.medium),
        noStylesheet: document.querySelector('link,style') === null,
        noClassNames: !Object.prototype.hasOwnProperty.call(tokenSource || {}, 'classNames') && !Object.prototype.hasOwnProperty.call(tokenSource || {}, 'stylesheet'),
    }, '*');
}

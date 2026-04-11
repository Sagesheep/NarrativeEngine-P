import '@testing-library/jest-dom';

Element.prototype.scrollIntoView = function () {};

Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return 40; },
});

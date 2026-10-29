import '@testing-library/jest-dom';

Element.prototype.scrollIntoView = function () {};
Element.prototype.scrollTo = function () {};

Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return 40; },
});

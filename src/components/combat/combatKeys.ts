export function isTypingTarget(target: EventTarget | null): boolean {
    if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
    const el = target as HTMLElement;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true || el.getAttribute?.('contenteditable') === 'true';
}

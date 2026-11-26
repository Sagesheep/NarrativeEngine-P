import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { InjectionEditor } from './InjectionEditor';

export function InjectionModifierPanel() {
    const open = useAppStore(s => s.injectionModifierOpen);
    const close = useAppStore(s => s.closeInjectionModifier);
    const campaignId = useAppStore(s => s.activeCampaignId);
    const panelRef = useRef<HTMLElement>(null);
    useEffect(() => {
        if (!open || !campaignId) return;
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        panelRef.current?.focus();
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && panelRef.current?.contains(event.target as Node)) {
                event.stopPropagation();
                close();
            }
        };
        const panel = panelRef.current;
        panel?.addEventListener('keydown', escape);
        return () => {
            panel?.removeEventListener('keydown', escape);
            if (previous?.isConnected) previous.focus();
        };
    }, [open, close, campaignId]);
    if (!open || !campaignId) return null;
    return (
        <aside data-motion="side-panel" ref={panelRef} tabIndex={-1} aria-label="Injection Modifier" data-ui="injection-modifier"
            className="fixed inset-y-0 right-0 z-[60] flex w-full min-w-0 flex-col border-l border-border bg-surface shadow-xl outline-none sm:w-[min(36rem,calc(100vw-2rem))] xl:static xl:z-auto xl:w-[min(36rem,38vw)] xl:shrink-0">
            <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
                <h2 className="text-sm font-semibold text-terminal">Injection Modifier</h2>
                <button type="button" onClick={close} aria-label="Close Injection Modifier" className="rounded-lg p-2 text-text-dim hover:bg-terminal/10 hover:text-terminal"><X size={17} /></button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <InjectionEditor key={campaignId} />
            </div>
        </aside>
    );
}

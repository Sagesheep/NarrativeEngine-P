import { Plus, SlidersHorizontal } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { normalizeInjections } from '../../services/payload/promptInjections';

/** Fast campaign-local toggles live next to Gallery, without opening an editor. */
export function InjectionQuickControls() {
    const campaignId = useAppStore(s => s.activeCampaignId);
    const value = useAppStore(s => s.context.promptInjections);
    const updateContext = useAppStore(s => s.updateContext);
    const open = useAppStore(s => s.openInjectionModifier);
    const items = normalizeInjections(value);
    return (
        <div data-motion="reveal" className="px-3 pb-3">
            {items.map(item => (
                <label key={item.id} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 hover:bg-terminal/5">
                    <input type="checkbox" role="switch" aria-label={`Enable ${item.name}`} checked={item.enabled}
                        disabled={!campaignId}
                        onChange={event => updateContext({ promptInjections: items.map(current => current.id === item.id ? { ...current, enabled: event.target.checked } : current) })}
                        className="mt-0.5 accent-terminal" />
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] text-text-primary">{item.name || 'Untitled injection'}</span>
                        <span className="block text-[9px] text-text-dim">{item.mode === 'message' ? `${item.role} · depth ${item.depth}` : `${item.mode} prefill`}</span>
                    </span>
                </label>
            ))}
            <button type="button" disabled={!campaignId} onClick={open}
                className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg border border-terminal/30 px-2 py-2 text-[11px] text-terminal hover:bg-terminal/10 disabled:opacity-40">
                {items.length ? <SlidersHorizontal size={13} /> : <Plus size={13} />}
                {items.length ? 'Edit injections' : 'Add injection'}
            </button>
        </div>
    );
}

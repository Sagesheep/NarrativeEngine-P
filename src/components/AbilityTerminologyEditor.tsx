import { RotateCcw } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import {
    ABILITY_CATEGORIES,
    ABILITY_CATEGORY_LABELS,
    ABILITY_ORIGINS,
    ABILITY_ORIGIN_LABELS,
    normalizeAbilityTerminology,
} from '../services/ability/abilitySchema';
import type { AbilityCategory, AbilityOrigin } from '../types';

export function AbilityTerminologyEditor() {
    const { context, updateContext } = useAppStore();
    const terminology = normalizeAbilityTerminology(context.abilityTerminology);

    const setOriginLabel = (origin: AbilityOrigin, label: string) => updateContext({
        abilityTerminology: {
            ...terminology,
            originLabels: { ...terminology.originLabels, [origin]: label },
        },
    });
    const setCategoryLabel = (category: AbilityCategory, label: string) => updateContext({
        abilityTerminology: {
            ...terminology,
            categoryLabels: { ...terminology.categoryLabels, [category]: label },
        },
    });

    return <div className="flex-1 overflow-y-auto p-5">
        <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h3 className="text-sm font-bold uppercase tracking-wider">Campaign Terminology</h3>
                    <p className="text-xs text-text-dim mt-1">
                        Change the displayed vocabulary without changing the Engine’s stable cross-system keys.
                        Empty fields use the default terms.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => updateContext({ abilityTerminology: { originLabels: {}, categoryLabels: {} } })}
                    className="px-3 py-2 border border-border rounded text-xs hover:text-terminal shrink-0"
                >
                    <RotateCcw size={13} className="inline mr-1" />Reset Defaults
                </button>
            </div>

            <section className="border border-border rounded p-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider mb-3">Ability Origins</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {ABILITY_ORIGINS.map(origin => <label key={origin} className="text-[10px] uppercase tracking-wider text-text-dim">
                        <span className="flex justify-between gap-2">
                            <span>{origin}</span><span className="normal-case opacity-60">Default: {ABILITY_ORIGIN_LABELS[origin]}</span>
                        </span>
                        <input
                            aria-label={`${origin} origin label`}
                            value={terminology.originLabels[origin] ?? ''}
                            onChange={event => setOriginLabel(origin, event.target.value)}
                            placeholder={ABILITY_ORIGIN_LABELS[origin]}
                            className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case"
                        />
                    </label>)}
                </div>
            </section>

            <section className="border border-border rounded p-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider mb-3">Ability Categories</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {ABILITY_CATEGORIES.map(category => <label key={category} className="text-[10px] uppercase tracking-wider text-text-dim">
                        <span className="flex justify-between gap-2">
                            <span>{category}</span><span className="normal-case opacity-60">Default: {ABILITY_CATEGORY_LABELS[category]}</span>
                        </span>
                        <input
                            aria-label={`${category} category label`}
                            value={terminology.categoryLabels[category] ?? ''}
                            onChange={event => setCategoryLabel(category, event.target.value)}
                            placeholder={ABILITY_CATEGORY_LABELS[category]}
                            className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case"
                        />
                    </label>)}
                </div>
            </section>
        </div>
    </div>;
}

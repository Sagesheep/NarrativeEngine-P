import { useEffect, useState } from 'react';
import { Cpu, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { API_BASE as API } from '../lib/apiBase';

type Specs = { cores: number; totalMemGB: number; cpuModel: string; suggestedSpeed: 'eco' | 'balanced' | 'aggressive' };

const SPEED_LABEL: Record<Specs['suggestedSpeed'], string> = {
    eco: 'Eco',
    balanced: 'Balanced',
    aggressive: 'Aggressive',
};

/**
 * One-time, first-run suggestion. After settings load, if we've never prompted, we ask
 * the server for the host's CPU/RAM and — when its suggested indexing speed differs from
 * the current setting — offer to apply it. Either choice (apply or keep) marks the prompt
 * as shown so it never reappears. Renders nothing in the common case.
 */
export function IndexingSpeedPrompt() {
    const settingsLoaded = useAppStore((s) => s.settingsLoaded);
    const settings = useAppStore((s) => s.settings);
    const updateSettings = useAppStore((s) => s.updateSettings);
    const [specs, setSpecs] = useState<Specs | null>(null);

    useEffect(() => {
        if (!settingsLoaded || settings.indexingSpeedPrompted) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`${API}/system/specs`);
                if (!res.ok) return;
                const data = (await res.json()) as Specs;
                const current = settings.indexingSpeed ?? 'balanced';
                // Only surface when the recommendation actually changes something.
                if (!cancelled && data.suggestedSpeed && data.suggestedSpeed !== current) {
                    setSpecs(data);
                } else if (!cancelled) {
                    updateSettings({ indexingSpeedPrompted: true });
                }
            } catch {
                /* offline / no server — try again next launch */
            }
        })();
        return () => { cancelled = true; };
    }, [settingsLoaded, settings.indexingSpeedPrompted, settings.indexingSpeed, updateSettings]);

    if (!specs) return null;

    const dismiss = () => { updateSettings({ indexingSpeedPrompted: true }); setSpecs(null); };
    const apply = () => { updateSettings({ indexingSpeed: specs.suggestedSpeed, indexingSpeedPrompted: true }); setSpecs(null); };

    return (
        <div className="fixed bottom-4 left-4 z-[200] max-w-[340px] border border-terminal bg-surface rounded shadow-lg font-mono animate-[toast-in_0.25s_ease-out]">
            <div className="flex items-start gap-2.5 p-3">
                <Cpu size={16} className="text-terminal shrink-0 mt-0.5" />
                <div className="min-w-0">
                    <p className="text-[11px] text-text-primary font-bold uppercase tracking-wider mb-1">
                        Tune indexing speed?
                    </p>
                    <p className="text-[10px] text-text-dim leading-snug">
                        Detected {specs.cores} CPU cores / {specs.totalMemGB} GB RAM. Use{' '}
                        <span className="text-terminal font-bold">{SPEED_LABEL[specs.suggestedSpeed]}</span> indexing
                        for {specs.suggestedSpeed === 'aggressive' ? 'faster' : 'lighter'} world imports?
                    </p>
                </div>
                <button onClick={dismiss} className="shrink-0 text-text-dim hover:text-text-primary ml-auto" title="Keep current">
                    <X size={12} />
                </button>
            </div>
            <div className="flex border-t border-border">
                <button
                    onClick={apply}
                    className="flex-1 py-1.5 text-[10px] uppercase tracking-wider font-bold bg-terminal text-void hover:bg-terminal/90 transition-colors"
                >
                    Use {SPEED_LABEL[specs.suggestedSpeed]}
                </button>
                <button
                    onClick={dismiss}
                    className="flex-1 py-1.5 text-[10px] uppercase tracking-wider text-text-dim hover:text-text-primary border-l border-border transition-colors"
                >
                    Keep {SPEED_LABEL[settings.indexingSpeed ?? 'balanced']}
                </button>
            </div>
        </div>
    );
}

import { useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { scanCharacterProfile } from '../../../services/characterProfileParser';
import { toast } from '../../Toast';
import type { EndpointConfig, ProviderConfig, CharacterProfile } from '../../../types';

// Local copy of the ledger's tab union -- deliberately not imported from
// CharacterLedgerModal, which imports this file.
type LedgerTab = 'sheet' | 'record' | 'inventory' | 'stats';

/**
 * Explicit labels for the three comma-separated lists. These used to be derived
 * from the key (`abilities` -> "Abilities"), which collided head-on with the
 * Sheet tab's "Abilities / Powers" and "Traits" -- same word, different store,
 * different prompt path. The hint says which one the user is looking at.
 */
const LIST_FIELDS: { k: 'skills' | 'abilities' | 'traits'; label: string; hint: string }[] = [
    { k: 'skills', label: 'Skills', hint: 'comma-separated' },
    { k: 'abilities', label: 'Abilities', hint: 'stat block — not the Signature Kit powers' },
    { k: 'traits', label: 'Traits', hint: 'stat block — not the Sheet tab traits' },
];

function SceneTag({ lastScene }: { lastScene: string }) {
    if (!lastScene || lastScene === 'Never') {
        return <span className="text-text-dim/40">Never updated</span>;
    }
    return <span className="text-terminal/70">Last updated: Scene #{lastScene}</span>;
}

/**
 * Character Ledger — Stats tab.
 *
 * Owner: engine scans, user edits. The `characterProfileData` stat block
 * (hp/level/skills/abilities) + `Populate Profile` button, moved verbatim
 * from the lower half of the old ContextDrawer `book` tab (BookkeepingTab.tsx).
 */
export function StatsTab({ onNavigateTab }: { onNavigateTab?: (tab: LedgerTab) => void } = {}) {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const messages = useAppStore((s) => s.messages);
    const archiveIndex = useAppStore((s) => s.archiveIndex);

    const characterProfileData = useAppStore((s) => s.characterProfileData ?? s.context.characterProfileData ?? s.context.characterProfile);
    const setCharacterProfileData = useAppStore((s) => s.setCharacterProfileData);
    const getActiveStoryEndpoint = useAppStore((s) => s.getActiveStoryEndpoint);

    const [rawEdit, setRawEdit] = useState(false);
    const [isScanningProfile, setIsScanningProfile] = useState(false);

    const getCurrentSceneId = (): string => {
        if (archiveIndex.length === 0) return '1';
        return archiveIndex[archiveIndex.length - 1].sceneId;
    };

    const handlePopulateProfile = async () => {
        if (isScanningProfile) return;
        setIsScanningProfile(true);
        try {
            const provider = getActiveStoryEndpoint();
            if (!provider) return;
            const newProfile = await scanCharacterProfile(provider as ProviderConfig | EndpointConfig, messages, characterProfileData as unknown as CharacterProfile);
            setCharacterProfileData(newProfile as unknown as CharacterProfile);
            updateContext({ characterProfileLastScene: getCurrentSceneId() });
        } catch (e) {
            console.error('Failed to scan character profile:', e);
            toast.error('Character profile scan failed');
        } finally {
            setIsScanningProfile(false);
        }
    };

    const profile = characterProfileData as CharacterProfile;

    return (
        <div className="px-4 py-4 space-y-4">
            <div className="flex items-center gap-2">
                <button
                    onClick={() => setRawEdit(!rawEdit)}
                    className="px-3 py-1.5 text-[10px] uppercase tracking-wider rounded transition-colors border bg-void border-border text-text-dim hover:border-text-primary"
                >
                    {rawEdit ? 'Form View' : 'Raw Edit'}
                </button>
            </div>

            <div className="pt-2">
                <div className="flex items-center justify-between mb-1">
                    <h3 className="text-[11px] uppercase tracking-wider text-ember">Character Profile</h3>
                </div>

                {/* Three tabs in this modal show character data; this is the one
                    the GM reads for numbers. Naming the other two here is what
                    stops them reading as duplicates that failed to sync. */}
                <p className="text-[9px] text-text-dim/50 leading-relaxed mb-2">
                    The stat block: numbers the GM reads. Narrative gear and powers live in{' '}
                    <button
                        onClick={() => onNavigateTab?.('sheet')}
                        disabled={!onNavigateTab}
                        className="text-amber-400/80 hover:text-amber-400 underline decoration-dotted underline-offset-2 disabled:no-underline disabled:text-text-dim/50"
                    >
                        Sheet &rsaquo; Signature Kit
                    </button>
                    , carried items in{' '}
                    <button
                        onClick={() => onNavigateTab?.('inventory')}
                        disabled={!onNavigateTab}
                        className="text-ice/80 hover:text-ice underline decoration-dotted underline-offset-2 disabled:no-underline disabled:text-text-dim/50"
                    >
                        Inventory
                    </button>
                    . These lists are separate on purpose and do not sync.
                </p>
                {rawEdit ? (
                    <textarea
                        className="w-full bg-void border border-border rounded text-text-primary text-[11px] px-2 py-1 focus:border-terminal outline-none font-mono"
                        rows={12}
                        value={JSON.stringify(profile, null, 2)}
                        onChange={(e) => {
                            try {
                                const parsed = JSON.parse(e.target.value);
                                setCharacterProfileData(parsed);
                            } catch { /* ignore */ }
                        }}
                    />
                ) : (
                    <div className="space-y-2">
                        {([
                            { k: 'name', label: 'Name' },
                            { k: 'race', label: 'Race' },
                            { k: 'class', label: 'Class' },
                            { k: 'level', label: 'Level', type: 'number' },
                        ] as { k: keyof CharacterProfile; label: string; type?: string }[]).map((f) => (
                            <div key={f.k} className="flex items-center gap-2">
                                <label className="text-[9px] text-text-dim/60 w-12">{f.label}</label>
                                <input
                                    className="flex-1 bg-transparent border-b border-border/50 hover:border-border focus:border-terminal outline-none text-text-primary text-[11px] px-1"
                                    type={f.type || 'text'}
                                    value={String(profile[f.k] ?? '')}
                                    onChange={(e) => setCharacterProfileData({ ...profile, [f.k]: f.type === 'number' ? Number(e.target.value) : e.target.value })}
                                />
                            </div>
                        ))}
                        <div className="flex items-center gap-2">
                            <label className="text-[9px] text-text-dim/60 w-12">HP</label>
                            <input
                                className="w-14 bg-transparent border-b border-border/50 hover:border-border focus:border-terminal outline-none text-text-primary text-[11px] px-1 text-center"
                                type="number"
                                value={profile.hp?.current ?? 0}
                                onChange={(e) => setCharacterProfileData({ ...profile, hp: { ...profile.hp, current: Number(e.target.value) } })}
                            />
                            <span className="text-text-dim/40">/</span>
                            <input
                                className="w-14 bg-transparent border-b border-border/50 hover:border-border focus:border-terminal outline-none text-text-primary text-[11px] px-1 text-center"
                                type="number"
                                value={profile.hp?.max ?? 0}
                                onChange={(e) => setCharacterProfileData({ ...profile, hp: { ...profile.hp, max: Number(e.target.value) } })}
                            />
                        </div>
                        {LIST_FIELDS.map(({ k, label, hint }) => (
                            <div key={k}>
                                <label className="text-[9px] text-text-dim/60">{label} <span className="text-text-dim/30">({hint})</span></label>
                                <input
                                    className="w-full bg-transparent border-b border-border/50 hover:border-border focus:border-terminal outline-none text-text-primary text-[11px] px-1"
                                    value={((profile[k] as string[] | undefined) ?? []).join(', ')}
                                    onChange={(e) => setCharacterProfileData({ ...profile, [k]: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                                />
                            </div>
                        ))}
                        <div>
                            <label className="text-[9px] text-text-dim/60">Notes</label>
                            <textarea
                                className="w-full bg-void border border-border/50 rounded text-text-primary text-[11px] px-2 py-1 focus:border-terminal outline-none"
                                rows={3}
                                value={profile.notes || ''}
                                onChange={(e) => setCharacterProfileData({ ...profile, notes: e.target.value })}
                            />
                        </div>
                    </div>
                )}
                <div className="mt-2 flex items-center justify-between">
                    <span className="text-[9px]"><SceneTag lastScene={context.characterProfileLastScene} /></span>
                    <button
                        onClick={handlePopulateProfile}
                        disabled={isScanningProfile}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-void border border-border hover:border-terminal text-text-primary text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50"
                    >
                        {isScanningProfile ? 'Scanning...' : 'Populate Profile'}
                    </button>
                </div>
            </div>
        </div>
    );
}
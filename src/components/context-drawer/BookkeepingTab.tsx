import { useState } from 'react';
import { Briefcase, RefreshCw, User, Settings2, List, Database } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { scanInventory } from '../../services/inventoryParser';
import { scanCharacterProfile } from '../../services/characterProfileParser';
import { TemplateField } from './TemplateField';
import { toast } from '../Toast';
import type { EndpointConfig, ProviderConfig } from '../../types';

function SceneTag({ lastScene }: { lastScene: string }) {
    if (!lastScene || lastScene === 'Never') {
        return <span className="text-text-dim/40">Never updated</span>;
    }
    return <span className="text-terminal/70">Last updated: Scene #{lastScene}</span>;
}

export function BookkeepingTab() {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const messages = useAppStore((s) => s.messages);
    const archiveIndex = useAppStore((s) => s.archiveIndex);
    const autoBookkeepingInterval = useAppStore((s) => s.autoBookkeepingInterval);
    const setAutoBookkeepingInterval = useAppStore((s) => s.setAutoBookkeepingInterval);
    const getActiveStoryEndpoint = useAppStore((s) => s.getActiveStoryEndpoint);
    const [isScanningInventory, setIsScanningInventory] = useState(false);
    const [isScanningProfile, setIsScanningProfile] = useState(false);
    const [showSettings, setShowSettings] = useState(false);

    const getCurrentSceneId = (): string => {
        if (archiveIndex.length === 0) return '1';
        return archiveIndex[archiveIndex.length - 1].sceneId;
    };

    const handleCheckInventory = async () => {
        if (isScanningInventory) return;
        setIsScanningInventory(true);
        try {
            const provider = getActiveStoryEndpoint();
            if (!provider) return;
            const newInventory = await scanInventory(provider as ProviderConfig | EndpointConfig, messages, context.inventory);
            const sceneId = getCurrentSceneId();
            updateContext({ inventory: newInventory, inventoryLastScene: sceneId });
        } catch (e) {
            console.error('Failed to scan inventory:', e);
            toast.error('Inventory scan failed');
        } finally {
            setIsScanningInventory(false);
        }
    };

    const handlePopulateProfile = async () => {
        if (isScanningProfile) return;
        setIsScanningProfile(true);
        try {
            const provider = getActiveStoryEndpoint();
            if (!provider) return;
            const newProfile = await scanCharacterProfile(provider as ProviderConfig | EndpointConfig, messages, context.characterProfile);
            const sceneId = getCurrentSceneId();
            updateContext({ characterProfile: newProfile, characterProfileLastScene: sceneId });
        } catch (e) {
            console.error('Failed to scan character profile:', e);
            toast.error('Character profile scan failed');
        } finally {
            setIsScanningProfile(false);
        }
    };

    return (
        <div className="px-4 py-4 space-y-4">
            <p className="text-[9px] text-text-dim/50">
                Toggle ON = appended to context. Use scan buttons to auto-update inventory/profile.
            </p>

            <div>
                <TemplateField
                    icon={<Briefcase size={13} />}
                    label="Player Inventory"
                    color="text-ice"
                    value={context.inventory}
                    onChange={(v) => updateContext({ inventory: v })}
                    placeholder={"- 50 Gold Coins\n- Rusty Sword\n- 3x Healing Potions"}
                    rows={6}
                    active={context.inventoryActive}
                    onToggle={() => updateContext({ inventoryActive: !context.inventoryActive })}
                />
                <div className="mt-1 flex items-center justify-between">
                    <span className="text-[9px]"><SceneTag lastScene={context.inventoryLastScene} /></span>
                </div>
                <div className="mt-2 flex justify-end">
                    <button
                        onClick={handleCheckInventory}
                        disabled={isScanningInventory}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-void border border-border hover:border-terminal text-text-primary text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed group"
                        title="Silent AI generation based on recent chat history"
                    >
                        <RefreshCw size={12} className={`text-terminal ${isScanningInventory ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
                        {isScanningInventory ? 'Scanning...' : 'Check Inventory'}
                    </button>
                </div>
            </div>

            <div className="pt-4 border-t border-border/50">
                <TemplateField
                    icon={<User size={13} />}
                    label="Character Profile"
                    color="text-ember"
                    value={context.characterProfile}
                    onChange={(v) => updateContext({ characterProfile: v })}
                    placeholder={"Name: Eldon\nRace: Elf\nClass: Rogue\nLevel: 3\n\nAbilities:\n- Stealth\n- Backstab"}
                    rows={6}
                    active={context.characterProfileActive}
                    onToggle={() => updateContext({ characterProfileActive: !context.characterProfileActive })}
                />
                <div className="mt-1 flex items-center justify-between">
                    <span className="text-[9px]"><SceneTag lastScene={context.characterProfileLastScene} /></span>
                </div>
                <div className="mt-2 flex justify-end">
                    <button
                        onClick={handlePopulateProfile}
                        disabled={isScanningProfile}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-void border border-border hover:border-terminal text-text-primary text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed group"
                        title="Silent AI generation based on recent chat history"
                    >
                        <RefreshCw size={12} className={`text-terminal ${isScanningProfile ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
                        {isScanningProfile ? 'Scanning...' : 'Populate Profile'}
                    </button>
                </div>
            </div>

            <div className="pt-4 border-t border-border/50">
                <TemplateField
                    icon={<List size={13} />}
                    label="Header Index"
                    color="text-ice"
                    value={context.headerIndex}
                    onChange={(v) => updateContext({ headerIndex: v })}
                    placeholder="Scene headers and pending loops..."
                    rows={4}
                    active={context.headerIndexActive}
                    onToggle={() => updateContext({ headerIndexActive: !context.headerIndexActive })}
                    hint="Auto-generated on condense"
                />
            </div>

            <div className="pt-4 border-t border-border/50">
                <TemplateField
                    icon={<Database size={13} />}
                    label="Canon State"
                    color="text-ember"
                    value={context.canonState}
                    onChange={(v) => updateContext({ canonState: v })}
                    placeholder="Persistent narrative canon..."
                    rows={6}
                    active={context.canonStateActive}
                    onToggle={() => updateContext({ canonStateActive: !context.canonStateActive })}
                    hint="Auto-generated on condense"
                />
            </div>

            <div className="pt-4 border-t border-border/50">
                <button
                    onClick={() => setShowSettings(!showSettings)}
                    className="flex items-center gap-1.5 text-text-dim/60 hover:text-text-primary text-[9px] uppercase tracking-wider transition-colors"
                >
                    <Settings2 size={10} />
                    {showSettings ? 'Hide' : 'Auto-Update Settings'}
                </button>
                {showSettings && (
                    <div className="mt-2 space-y-2">
                        <div className="flex items-center gap-2">
                            <label className="text-[9px] text-text-dim/60 uppercase tracking-wider whitespace-nowrap">
                                Scan every N turns:
                            </label>
                            <input
                                type="number"
                                min={1}
                                max={50}
                                value={autoBookkeepingInterval}
                                onChange={(e) => setAutoBookkeepingInterval(Number(e.target.value))}
                                className="w-16 px-2 py-1 bg-void border border-border rounded text-text-primary text-[11px] text-center focus:outline-none focus:border-terminal"
                            />
                        </div>
                        <p className="text-[8px] text-text-dim/40">
                            Profile and inventory are auto-scanned every N player turns via background queue (max 2 concurrent LLM calls).
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

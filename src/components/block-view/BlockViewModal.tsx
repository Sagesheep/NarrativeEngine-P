import { useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n/useTranslation';
import { isBlockEnabled } from '../../services/turn/blockEnablement';
import { MATRIX } from '../../services/turn/aiTier';
import type { AiTier } from '../../types';
import { enumerateBlocks, type Block, type BlockSource } from './blockModel';
import { BlockCard } from './BlockCard';
import { TierPresetBar } from './TierPresetBar';
import { setRoleModuleEnabled } from '../../services/roles';
import { ScreenLightbox } from '../ScreenLightbox';

/**
 * WORKORDER-P5-02 — the Block View modal.
 *
 * A Header-launched overlay (NOT a settings tab — see the work order §3) showing one turn as
 * a left-to-right chain of blocks. Every block is enumerated from one of three registries;
 * none is named by id in this file (the §4 / §8 hard failure condition). v1 is view + toggle
 * only: no drag, no reorder, no inserting blocks.
 *
 * Pattern follows `LocationLedgerModal`: open state + toggle live in the uiSlice, the
 * component returns null when closed, Escape closes, the scrim click closes. Wide content
 * scrolls inside its own container — the page body never scrolls horizontally.
 */
export function BlockViewModal() {
    const blockViewOpen = useAppStore((s) => s.blockViewOpen);
    const toggleBlockView = useAppStore((s) => s.toggleBlockView);
    const settings = useAppStore((s) => s.settings);
    const updateSettings = useAppStore((s) => s.updateSettings);
    const { t } = useTranslation();

    // Enumerate once per open. The registries are stable across a turn, and rebuilding on
    // every render would call the mod loader's accessor needlessly. `useMemo([])` mirrors
    // the ExtensionsTab's `builtinRows` pattern.
    const moduleEnabled = settings?.moduleEnabled;
    const blocks = useMemo(() => enumerateBlocks(), []);

    if (!blockViewOpen) return null;

    const aiTier = (settings?.aiTier ?? 'pro') as AiTier;
    // The single enablement resolver — same one the turn uses. §5: "Never read moduleEnabled
    // directly." For tier features the real tier is passed; for contributions/tracks the
    // resolver's matrix-miss → enabled rule makes the tier irrelevant (it is passed through
    // anyway so a contribution that happens to share a TierFeature id resolves consistently).
    const isEnabled = (id: string) => isBlockEnabled(id, aiTier, moduleEnabled);

    // §6 — the tier preset switcher writes the preset's positions into moduleEnabled as
    // EXPLICIT values. After WO-P5-01 an explicit entry beats the preset, so writing them
    // explicitly is what makes the view's display match what the next turn will do.
    const applyPreset = (tier: AiTier) => {
        const next: Record<string, boolean> = { ...(moduleEnabled ?? {}) };
        const preset = MATRIX[tier];
        for (const id of Object.keys(preset) as (keyof typeof preset)[]) {
            next[id] = preset[id];
        }
        updateSettings({ moduleEnabled: next });
        setRoleModuleEnabled(next);
    };

    // Clear every explicit override for a TierFeature id, so the tier preset decides again.
    // Contribution/track overrides are untouched — they were never driven by a preset.
    const clearOverrides = () => {
        if (!moduleEnabled) return;
        const presetIds = new Set<string>(Object.keys(MATRIX.pro));
        const next: Record<string, boolean> = {};
        for (const [id, val] of Object.entries(moduleEnabled)) {
            if (!presetIds.has(id)) next[id] = val;
        }
        updateSettings({ moduleEnabled: next });
        setRoleModuleEnabled(next);
    };

    const setEnabled = (id: string, enabled: boolean) => {
        const next = { ...(moduleEnabled ?? {}), [id]: enabled };
        updateSettings({ moduleEnabled: next });
        setRoleModuleEnabled(next);
    };

    const renderSection = (source: BlockSource, list: Block[]) => {
        // Always render the section header — even an empty section tells the user this
        // registry exists and currently publishes nothing (e.g. zero mods installed).
        const titleKey =
            source === 'tier' ? 'blockview.section.tier'
            : source === 'contribution' ? 'blockview.section.contrib'
            : source === 'track' ? 'blockview.section.tracks'
            : 'blockview.section.roles';
        const helpKey =
            source === 'tier' ? 'blockview.section.tier.help'
            : source === 'contribution' ? 'blockview.section.contrib.help'
            : source === 'track' ? 'blockview.section.tracks.help'
            : 'blockview.section.roles.help';
        return (
            <section className="space-y-2">
                <div>
                    <label className="chrome-label block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
                        {t(titleKey)}
                    </label>
                    <p className="text-[9px] text-text-dim leading-tight max-w-[680px]">
                        {t(helpKey)}
                    </p>
                </div>
                {list.length === 0 ? (
                    <p className="text-[9px] text-text-dim italic px-3 py-2 border border-dashed border-border rounded">
                        {t('blockview.empty')}
                    </p>
                ) : (
                    // The chain scrolls horizontally inside its own container — the page body
                    // never scrolls sideways (WO-P5-02 §2 / §9 375px check). `w-max-content`
                    // lets the row grow as wide as the blocks need; the outer div clips it.
                    <div className="overflow-x-auto border border-border bg-void-light rounded">
                        <div className="flex items-stretch gap-3 p-3 w-max-content">
                            {list.map((block) => (
                                (() => {
                                    const settingId = block.source === 'contribution'
                                        ? block.id.slice('contribution:'.length)
                                        : block.id;
                                    return (
                                <BlockCard
                                    key={`${source}:${block.id}`}
                                    block={block}
                                    enabled={isEnabled(settingId)}
                                    onToggle={(_id, enabled) => setEnabled(settingId, enabled)}
                                />
                                    );
                                })()
                            ))}
                        </div>
                    </div>
                )}
            </section>
        );
    };

    return (
        <ScreenLightbox size="full" width="wide" title={t('blockview.title')} onClose={toggleBlockView}>
            <div className="flex flex-col min-h-full">

                {/* Standfirst + legend */}
                <div className="px-4 py-3 border-b border-border bg-void-lighter shrink-0 space-y-2">
                    <p className="text-[11px] text-text-dim leading-tight max-w-[74ch]">
                        {t('blockview.standfirst')}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">
                        <span className="flex items-center gap-1.5">
                            <span className="inline-block w-2 h-2 border border-ember bg-ember-wash" />
                            {t('blockview.legend.engine')}
                            <span className="normal-case tracking-normal text-text-dim/70">— {t('blockview.legend.engine.help')}</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="inline-block w-2 h-2 border border-terminal bg-terminal-wash" />
                            {t('blockview.legend.model')}
                            <span className="normal-case tracking-normal text-text-dim/70">— {t('blockview.legend.model.help')}</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="inline-block w-2 h-2 border border-border-strong bg-surface" style={{ borderStyle: 'dashed' }} />
                            {t('blockview.legend.locked')}
                            <span className="normal-case tracking-normal text-text-dim/70">— {t('blockview.legend.locked.help')}</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="inline-block w-2 h-2 border border-ember bg-ember-wash" style={{ opacity: 0.5 }} />
                            {t('blockview.legend.manual')}
                            <span className="normal-case tracking-normal text-text-dim/70">— {t('blockview.legend.manual.help')}</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="inline-block w-2 h-2 border border-border-strong bg-transparent" style={{ borderStyle: 'dotted' }} />
                            {t('blockview.legend.unwired')}
                            <span className="normal-case tracking-normal text-text-dim/70">— {t('blockview.legend.unwired.help')}</span>
                        </span>
                    </div>
                </div>

                {/* Tier context + preset bar */}
                <div className="px-4 py-3 border-b border-border bg-void-lighter shrink-0">
                    <TierPresetBar
                        aiTier={aiTier}
                        onApply={applyPreset}
                        onClear={clearOverrides}
                        hasOverrides={!!moduleEnabled && Object.keys(MATRIX.pro).some((id) => id in moduleEnabled)}
                    />
                </div>

                {/* Scrollable body — vertical only. The chains inside scroll horizontally. */}
                <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-5">
                    {renderSection('tier', blocks.tier)}
                    {renderSection('contribution', blocks.contributions)}
                    {renderSection('track', blocks.tracks)}
                    {renderSection('role', blocks.roles ?? [])}
                </div>
            </div>
        </ScreenLightbox>
    );
}

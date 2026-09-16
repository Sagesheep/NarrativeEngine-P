import { useCallback, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Plus, Star, User } from 'lucide-react';
import { ScreenLightbox } from '../ScreenLightbox';
import { ImportOverwriteDialog } from './ImportOverwriteDialog';
import { toast } from '../Toast';
import { useAppStore } from '../../store/useAppStore';
import { uid } from '../../utils/uid';
import { parseJsonCard, parsePngCard } from '../../services/import/stCardParser';
import { seedCardToCampaignParts } from '../../services/import/stCardConvert';
import {
    applyPersona,
    applyStar,
    autoStarIndex,
    canSeed,
    findDuplicateGroups,
    type ShelfTile,
} from '../../services/import/shelf';
import {
    buildImportPlan,
    createCampaignFromImport,
    rosterTilesForImport,
    type ImportChoices,
    type ImportPlan,
} from '../../services/import/importCampaign';
import { downscaleCover } from '../../services/import/coverImage';
import {
    saveCampaign,
    saveCampaignState,
    saveLoreChunks,
    saveNPCLedger,
} from '../../store/campaignStore';
import { hydrateCampaign } from '../../store/campaignHydrator';
import { uploadImageToLocal } from '../../services/infrastructure/assetService';
import type { LoreChunk } from '../../types';
import type { STCard } from '../../services/import/stCardTypes';

/**
 * WO-C §4 — the SillyTavern card import wizard.
 *
 * Four steps, one offline path. Nothing here makes an LLM call: §10.1 keeps the
 * Living-world adaptation choice out of this round entirely, so the Review step
 * renders no Living-world/Direct radio — there is one path and it is offline.
 *
 * The wizard owns only UI state. Every rule that can be stated without a DOM
 * lives in `services/import/` (`shelf.ts`, `importCampaign.ts`) and is tested
 * without mounting anything.
 */

type Step = 1 | 2 | 3 | 4;
type WhoKind = 'build-own' | 'persona';

/** §9.5 — why a dropped file yielded no card, said in the user's terms. */
const FAILURE_COPY: Record<string, string> = {
    'not-png': 'Not a PNG — a WebP/JPEG saved from a preview loses the card data; download the original file',
    'no-card-payload': 'No card data in this image — download the original card file, a re-saved preview strips it',
    'malformed-payload': 'Card data is damaged',
    'truncated': 'File is truncated',
    'not-json': 'Not valid JSON',
    'not-card': 'Not a character card',
};

/** §9.2 — shown verbatim before creation. Card import is not a world builder. */
const LIGHTWEIGHT_DISCLOSURE =
    'This creates a lightweight campaign. Card import does not generate structured geography, '
    + 'governments/politics, factions/institutions, cultures/religions, economy/resources, '
    + 'history/conflicts, or magic/technology rules. Embedded lore may mention some of these. '
    + 'You can add native World Lore later.';

const SEED_HINT = '★ = Campaign Seed: its scenario becomes your world premise and opening scene';
const SEED_RIBBON = 'CAMPAIGN SEED — proposes premise & opening scene';
const NO_SEED_TOOLTIP = "no scenario in this card — can't seed a world";

const FIELD = 'w-full bg-void border border-border rounded px-2 py-1.5 text-xs text-text-primary focus:border-terminal focus:outline-none';
const LABEL = 'block text-[10px] uppercase tracking-wider text-text-dim mb-1';

/**
 * `Blob.arrayBuffer()` / `Blob.text()` are Chromium-native but absent from the
 * jsdom `File` the tests build, so the shelf would be untestable if it called
 * them directly. Prefer the native method, fall back to `FileReader` (which
 * jsdom does implement) — same bytes either way.
 */
function readArrayBuffer(file: File): Promise<ArrayBuffer> {
    if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
        reader.readAsArrayBuffer(file);
    });
}

function readText(file: File): Promise<string> {
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
        reader.readAsText(file);
    });
}

export function STImportWizard({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
    const matureMode = useAppStore(s => s.settings?.matureMode ?? false);

    const [tiles, setTiles] = useState<ShelfTile[]>([]);
    const [files, setFiles] = useState<Map<string, File>>(() => new Map());
    const [thumbs, setThumbs] = useState<Record<string, string>>({});
    /** Extra per-tile explanation beyond the FAILURE_COPY line (§9.5). */
    const [hints, setHints] = useState<Record<string, string>>({});
    const [step, setStep] = useState<Step>(1);
    const [mode, setMode] = useState<ImportChoices['mode']>('seeded');
    const [greetingIndex, setGreetingIndex] = useState(0);
    const [whoKind, setWhoKind] = useState<WhoKind>('build-own');
    const [playerName, setPlayerName] = useState('You');
    const [campaignName, setCampaignName] = useState('');
    const [premise, setPremise] = useState('');
    const [opening, setOpening] = useState('');
    const [sourcePremise, setSourcePremise] = useState('');
    const [sourceOpening, setSourceOpening] = useState('');
    const [touched, setTouched] = useState({ name: false, premise: false, opening: false });
    const [dupQueue, setDupQueue] = useState<string[]>([]);
    const [dupIndex, setDupIndex] = useState(0);
    const [dupRes, setDupRes] = useState<Record<string, 'overwrite' | 'skip'>>({});
    const [creating, setCreating] = useState(false);

    const inputRef = useRef<HTMLInputElement>(null);
    const objectUrls = useRef<string[]>([]);

    // Reset on open, render-phase (the repo lints with react-hooks recommended,
    // which flags set-state-in-effect). Mirrors CharacterLedgerModal.
    const [prevOpen, setPrevOpen] = useState(false);
    if (prevOpen !== open) {
        setPrevOpen(open);
        if (open) {
            setTiles([]);
            setFiles(new Map());
            setThumbs({});
            setHints({});
            setStep(1);
            setMode('seeded');
            setGreetingIndex(0);
            setWhoKind('build-own');
            setPlayerName('You');
            setCampaignName('');
            setPremise('');
            setOpening('');
            setSourcePremise('');
            setSourceOpening('');
            setTouched({ name: false, premise: false, opening: false });
            setDupQueue([]);
            setDupIndex(0);
            setDupRes({});
            setCreating(false);
        }
    }

    const personaTile = tiles.find(t => t.persona) ?? null;
    const seedTile = tiles.find(t => t.star && t.card) ?? null;
    const parsedCount = tiles.filter(t => t.card).length;
    const resolvedPlayerName = whoKind === 'persona' && personaTile?.card
        ? personaTile.card.name.trim() || 'You'
        : playerName.trim() || 'You';

    const handleClose = useCallback(() => {
        for (const url of objectUrls.current) URL.revokeObjectURL(url);
        objectUrls.current = [];
        onClose();
    }, [onClose]);

    // ── Step 1: the shelf ───────────────────────────────────────────────────

    const addFiles = async (incoming: File[]) => {
        if (incoming.length === 0) return;
        const added: ShelfTile[] = [];
        const nextFiles = new Map(files);
        const nextThumbs: Record<string, string> = {};
        const nextHints: Record<string, string> = {};

        for (const file of incoming) {
            const id = uid();
            let card: STCard | null = null;
            let failure: ShelfTile['failure'];

            if (file.name.toLowerCase().endsWith('.json')) {
                const text = await readText(file);
                let parsed: unknown;
                let bad = false;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    failure = 'not-json';
                    bad = true;
                }
                if (!bad) {
                    if (Array.isArray(parsed)) {
                        // The legacy cross-campaign NPC export, not a card.
                        failure = 'not-card';
                        nextHints[id] = "this is an NPC export — use the NPC Ledger's Import button";
                    } else {
                        card = parseJsonCard(text);
                        if (!card) failure = 'not-card';
                    }
                }
            } else {
                const result = parsePngCard(await readArrayBuffer(file));
                if (result.ok) card = result.card;
                else failure = result.reason;
            }

            nextFiles.set(id, file);
            // jsdom has no object URLs; a missing thumbnail is not a failure.
            if (card && file.type.startsWith('image/') && typeof URL.createObjectURL === 'function') {
                const url = URL.createObjectURL(file);
                objectUrls.current.push(url);
                nextThumbs[id] = url;
            }
            added.push({ id, fileName: file.name, card, failure, star: false, persona: false });
        }

        setFiles(nextFiles);
        setThumbs(prev => ({ ...prev, ...nextThumbs }));
        setHints(prev => ({ ...prev, ...nextHints }));
        setTiles(prev => {
            const next = [...prev, ...added];
            if (next.some(t => t.star)) return next;
            const auto = autoStarIndex(next);
            return auto === null ? next : applyStar(next, auto);
        });
    };

    const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
        const picked = Array.from(e.target.files ?? []);
        e.target.value = '';
        void addFiles(picked);
    };

    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        void addFiles(Array.from(e.dataTransfer.files ?? []));
    };

    // ── Step transitions ────────────────────────────────────────────────────

    const enterReview = (nextMode: ImportChoices['mode']) => {
        setMode(nextMode);
        const personaId = nextMode === 'seeded' ? personaTile?.id ?? null : null;
        const roster = rosterTilesForImport(tiles, nextMode, personaId);
        const later = findDuplicateGroups(roster).flatMap(g => g.indexes.slice(1).map(i => roster[i].id));
        setDupQueue(later);
        setDupIndex(0);
        setDupRes({});

        const seed = nextMode === 'seeded' ? seedTile : null;
        if (seed?.card) {
            // Preview only — the real ids are minted by buildImportPlan on create.
            const parts = seedCardToCampaignParts(seed.card, greetingIndex, resolvedPlayerName, () => 'preview');
            const p = parts.premiseChunk?.content ?? '';
            const o = parts.opening?.content ?? '';
            setSourcePremise(p);
            setSourceOpening(o);
            if (!touched.premise) setPremise(p);
            if (!touched.opening) setOpening(o);
            if (!touched.name) setCampaignName(seed.card.name.trim());
        } else {
            setSourcePremise('');
            setSourceOpening('');
            if (!touched.premise) setPremise('');
            if (!touched.opening) setOpening('');
            if (!touched.name) setCampaignName('Imported cast');
        }
        setStep(4);
    };

    const hasAlternates = (seedTile?.card?.alternate_greetings.length ?? 0) > 0;

    const continueFromShelf = () => setStep(hasAlternates ? 2 : 3);

    /** Step 2 exists only for a card with alternates, so Back has to skip it. */
    const goBack = () => {
        if (step === 4) setStep(mode === 'npcs-only' ? 1 : 3);
        else if (step === 3) setStep(hasAlternates ? 2 : 1);
        else setStep(1);
    };

    // ── Review data ─────────────────────────────────────────────────────────
    // Built WITHOUT the premise/opening/name overrides so typing in the Review
    // textareas does not re-run the converter (and its tokenizer) per keystroke.
    const reviewPlan = useMemo<ImportPlan | null>(() => {
        if (step !== 4) return null;
        const who: ImportChoices['who'] = whoKind === 'persona' && personaTile
            ? { kind: 'persona', tileId: personaTile.id }
            : { kind: 'build-own', playerName };
        return buildImportPlan(tiles, files, {
            mode, greetingIndex, who, campaignName: '', duplicateResolutions: dupRes,
        }, { matureMode });
    }, [step, tiles, files, mode, greetingIndex, whoKind, personaTile, playerName, dupRes, matureMode]);

    const reviewChunks = useMemo<LoreChunk[]>(() => {
        if (!reviewPlan) return [];
        const out: LoreChunk[] = [];
        if (reviewPlan.seedParts?.premiseChunk) out.push(reviewPlan.seedParts.premiseChunk);
        if (reviewPlan.seedParts?.quarantineChunk) out.push(reviewPlan.seedParts.quarantineChunk);
        for (const entry of reviewPlan.roster) out.push(...entry.loreChunks);
        if (reviewPlan.persona) out.push(...reviewPlan.persona.loreChunks);
        return out;
    }, [reviewPlan]);

    const chunkGroups = useMemo(() => {
        const map = new Map<string, LoreChunk[]>();
        for (const chunk of reviewChunks) {
            const key = chunk.group ?? 'Imported';
            const list = map.get(key);
            if (list) list.push(chunk);
            else map.set(key, [chunk]);
        }
        return [...map.entries()];
    }, [reviewChunks]);

    // ── Create ──────────────────────────────────────────────────────────────

    const handleCreate = async () => {
        setCreating(true);
        try {
            const who: ImportChoices['who'] = whoKind === 'persona' && personaTile
                ? { kind: 'persona', tileId: personaTile.id }
                : { kind: 'build-own', playerName };
            const plan = buildImportPlan(tiles, files, {
                mode,
                greetingIndex,
                who,
                campaignName,
                premiseOverride: premise,
                openingOverride: opening,
                duplicateResolutions: dupRes,
            }, { matureMode });

            const result = await createCampaignFromImport(plan, {
                saveCampaign,
                saveLoreChunks,
                saveNPCLedger,
                saveCampaignState,
                hydrateCampaign,
                uploadImageToLocal,
                downscaleCover,
            });

            const loreCount = (plan.seedParts?.premiseChunk ? 1 : 0)
                + (plan.seedParts?.quarantineChunk ? 1 : 0)
                + plan.roster.reduce((sum, e) => sum + e.loreChunks.length, 0)
                + (plan.persona?.loreChunks.length ?? 0);
            const tail = plan.persona
                ? `you are playing as ${plan.persona.pc.name}.`
                : 'send a message to create your character.';
            const failures = result.portraitFailures.length > 0
                ? ` Portraits could not be saved for ${result.portraitFailures.join(', ')}.`
                : '';
            toast.success(`Imported ${plan.roster.length} characters and ${loreCount} lore entries — ${tail}${failures}`);
            onDone();
            handleClose();
        } catch (err) {
            console.error('[STImport] Create failed:', err);
            toast.error('Import failed — nothing was created. Check that the server is running.');
        } finally {
            setCreating(false);
        }
    };

    if (!open) return null;

    const stepChips: { n: Step; label: string }[] = [
        { n: 1, label: 'Cards' },
        ...(mode === 'npcs-only' ? [] : [
            ...(hasAlternates ? [{ n: 2 as Step, label: 'Greeting' }] : []),
            { n: 3 as Step, label: 'Who are you?' },
        ]),
        { n: 4, label: 'Review' },
    ];

    const pendingDupId = dupIndex < dupQueue.length ? dupQueue[dupIndex] : null;
    const pendingDupTile = pendingDupId ? tiles.find(t => t.id === pendingDupId) ?? null : null;

    const resolveDup = (choice: 'overwrite' | 'skip') => {
        if (!pendingDupId) return;
        setDupRes(prev => ({ ...prev, [pendingDupId]: choice }));
        setDupIndex(i => i + 1);
    };

    return (
        <ScreenLightbox size="default" width="wide" title="Import from SillyTavern" onClose={handleClose}>
            <div className="flex-1 min-h-0 flex flex-col relative">
                {/* Step chips */}
                <div className="flex items-center gap-2 shrink-0 pb-3 border-b border-border">
                    {stepChips.map(chip => (
                        <div
                            key={chip.n}
                            className={`px-2 py-1 text-[10px] uppercase tracking-wider border rounded ${
                                step === chip.n
                                    ? 'text-terminal border-terminal'
                                    : 'text-text-dim border-border'
                            }`}
                        >
                            {chip.label}
                        </div>
                    ))}
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto py-4">
                    {step === 1 && (
                        <div
                            onDragOver={e => e.preventDefault()}
                            onDrop={onDrop}
                            data-testid="st-card-shelf"
                            className="min-h-[240px]"
                        >
                            <input
                                ref={inputRef}
                                type="file"
                                multiple
                                accept=".png,.json"
                                className="hidden"
                                data-testid="st-card-input"
                                onChange={onPick}
                            />
                            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                                <button
                                    type="button"
                                    onClick={() => inputRef.current?.click()}
                                    className="aspect-[3/4] flex flex-col items-center justify-center gap-2 border border-dashed border-border rounded text-text-dim hover:border-terminal hover:text-terminal transition-colors"
                                >
                                    <Plus size={22} />
                                    <span className="text-[10px] uppercase tracking-wider">Add cards</span>
                                </button>

                                {tiles.map((tile, index) => (
                                    <CardTile
                                        key={tile.id}
                                        tile={tile}
                                        thumb={thumbs[tile.id]}
                                        hint={hints[tile.id]}
                                        onToggleStar={() => setTiles(prev => applyStar(prev, index))}
                                    />
                                ))}
                            </div>
                            <p className="mt-4 text-[11px] text-text-dim">{SEED_HINT}</p>
                        </div>
                    )}

                    {step === 2 && seedTile?.card && (
                        <GreetingStep
                            card={seedTile.card}
                            value={greetingIndex}
                            onChange={setGreetingIndex}
                        />
                    )}

                    {step === 3 && (
                        <div className="space-y-5 max-w-xl">
                            <label className="flex items-start gap-2 cursor-pointer">
                                <input
                                    type="radio"
                                    name="st-who"
                                    checked={whoKind === 'build-own'}
                                    onChange={() => { setWhoKind('build-own'); setTiles(prev => applyPersona(prev, null)); }}
                                    className="mt-0.5"
                                />
                                <span>
                                    <span className="text-xs text-text-primary font-semibold">Build my own character</span>
                                    <span className="block text-[11px] text-text-dim mt-1">
                                        Use the name your character will have — you&apos;ll finish the full character in the
                                        Character panel after import.
                                    </span>
                                </span>
                            </label>
                            {whoKind === 'build-own' && (
                                <div className="pl-6">
                                    <label className={LABEL} htmlFor="st-player-name">Player character name</label>
                                    <input
                                        id="st-player-name"
                                        className={`${FIELD} max-w-xs`}
                                        value={playerName}
                                        onChange={e => setPlayerName(e.target.value)}
                                    />
                                </div>
                            )}

                            <label className="flex items-start gap-2 cursor-pointer">
                                <input
                                    type="radio"
                                    name="st-who"
                                    checked={whoKind === 'persona'}
                                    onChange={() => setWhoKind('persona')}
                                    className="mt-0.5"
                                />
                                <span>
                                    <span className="text-xs text-text-primary font-semibold">Play as one of my cards</span>
                                    <span className="block text-[11px] text-text-dim mt-1">
                                        That card becomes your character instead of an NPC. The ★ seed card is not offered —
                                        it is the world&apos;s anchor character.
                                    </span>
                                </span>
                            </label>
                            {whoKind === 'persona' && (
                                <div className="pl-6 flex flex-wrap gap-2">
                                    {tiles.map((tile, index) => (
                                        tile.card && !tile.star ? (
                                            <button
                                                key={tile.id}
                                                type="button"
                                                onClick={() => setTiles(prev => applyPersona(prev, index))}
                                                className={`px-2 py-1.5 border rounded text-[11px] transition-colors ${
                                                    tile.persona
                                                        ? 'border-terminal text-terminal'
                                                        : 'border-border text-text-dim hover:border-terminal'
                                                }`}
                                            >
                                                {tile.persona ? '👤 This is me · ' : ''}{tile.card.name}
                                            </button>
                                        ) : null
                                    ))}
                                    {tiles.every(t => !t.card || t.star) && (
                                        <p className="text-[11px] text-text-dim">Drop a second card to play as one of them.</p>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {step === 4 && reviewPlan && (
                        <div className="space-y-5">
                            <div className="max-w-sm">
                                <label className={LABEL} htmlFor="st-campaign-name">Campaign name</label>
                                <input
                                    id="st-campaign-name"
                                    className={FIELD}
                                    value={campaignName}
                                    onChange={e => { setCampaignName(e.target.value); setTouched(t => ({ ...t, name: true })); }}
                                />
                            </div>

                            <div>
                                <div className={LABEL}>{reviewPlan.roster.length} characters</div>
                                <div className="flex flex-wrap gap-2">
                                    {reviewPlan.roster.map(entry => (
                                        <div key={entry.tileId} className="w-[92px] text-center">
                                            <div className="aspect-[3/4] bg-void border border-border rounded overflow-hidden flex items-center justify-center">
                                                {thumbs[entry.tileId]
                                                    ? <img src={thumbs[entry.tileId]} alt="" className="w-full h-full object-cover" />
                                                    : <User size={18} className="text-text-dim" />}
                                            </div>
                                            <div className="text-[10px] text-text-dim mt-1 truncate">
                                                {entry.tileId === seedTile?.id && mode === 'seeded' ? '★ ' : ''}{entry.npc.name}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div>
                                <div className={LABEL}>{reviewChunks.length} lore entries</div>
                                <div className="space-y-1">
                                    {chunkGroups.map(([group, list]) => (
                                        <div key={group} className="text-[11px] text-text-dim">
                                            <span className="text-terminal">{group}</span> — {list.length} {list.length === 1 ? 'entry' : 'entries'}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {mode === 'seeded' && (
                                <>
                                    <div>
                                        <div className="flex items-center justify-between">
                                            <label className={LABEL} htmlFor="st-premise">Campaign premise</label>
                                            <button
                                                type="button"
                                                className="text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal"
                                                onClick={() => { setPremise(sourcePremise); setTouched(t => ({ ...t, premise: true })); }}
                                            >
                                                Reset to source
                                            </button>
                                        </div>
                                        <textarea
                                            id="st-premise"
                                            className={`${FIELD} h-24 resize-y`}
                                            value={premise}
                                            onChange={e => { setPremise(e.target.value); setTouched(t => ({ ...t, premise: true })); }}
                                        />
                                    </div>
                                    <div>
                                        <div className="flex items-center justify-between">
                                            <label className={LABEL} htmlFor="st-opening">Opening scene</label>
                                            <button
                                                type="button"
                                                className="text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal"
                                                onClick={() => { setOpening(sourceOpening); setTouched(t => ({ ...t, opening: true })); }}
                                            >
                                                Reset to source
                                            </button>
                                        </div>
                                        <textarea
                                            id="st-opening"
                                            className={`${FIELD} h-32 resize-y`}
                                            value={opening}
                                            onChange={e => { setOpening(e.target.value); setTouched(t => ({ ...t, opening: true })); }}
                                        />
                                    </div>
                                </>
                            )}

                            <p className="text-[11px] text-text-dim leading-relaxed border border-border rounded p-3">
                                {LIGHTWEIGHT_DISCLOSURE}
                            </p>

                            <SummaryBlock plan={reviewPlan} />
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="shrink-0 border-t border-border pt-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        {step !== 1 && (
                            <button
                                type="button"
                                onClick={goBack}
                                className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-dim border border-border rounded hover:text-terminal hover:border-terminal transition-colors"
                            >
                                Back
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {step === 1 && (
                            <>
                                <button
                                    type="button"
                                    disabled={parsedCount === 0}
                                    onClick={() => enterReview('npcs-only')}
                                    className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-dim border border-border rounded hover:text-terminal hover:border-terminal transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                >
                                    Import as NPCs only
                                </button>
                                <button
                                    type="button"
                                    disabled={parsedCount === 0 || !seedTile}
                                    onClick={continueFromShelf}
                                    className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-terminal border border-terminal rounded hover:bg-terminal/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                >
                                    Continue
                                </button>
                            </>
                        )}
                        {step === 2 && (
                            <button
                                type="button"
                                onClick={() => setStep(3)}
                                className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-terminal border border-terminal rounded hover:bg-terminal/10 transition-colors"
                            >
                                Continue
                            </button>
                        )}
                        {step === 3 && (
                            <button
                                type="button"
                                disabled={whoKind === 'persona' && !personaTile}
                                onClick={() => enterReview('seeded')}
                                className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-terminal border border-terminal rounded hover:bg-terminal/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                                Continue
                            </button>
                        )}
                        {step === 4 && (
                            <button
                                type="button"
                                disabled={creating || !reviewPlan || reviewPlan.roster.length === 0}
                                onClick={handleCreate}
                                className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-terminal border border-terminal rounded hover:bg-terminal/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                            >
                                {creating && <Loader2 size={12} className="animate-spin" />}
                                Create campaign
                            </button>
                        )}
                    </div>
                </div>

                {/* §9.4 — intra-drop duplicates, answered before the summary is final. */}
                {step === 4 && pendingDupTile?.card && (
                    <ImportOverwriteDialog
                        name={pendingDupTile.card.name}
                        kind="duplicate"
                        onOverwrite={() => resolveDup('overwrite')}
                        onCancel={() => resolveDup('skip')}
                    />
                )}
            </div>
        </ScreenLightbox>
    );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function CardTile({ tile, thumb, hint, onToggleStar }: {
    tile: ShelfTile;
    thumb?: string;
    hint?: string;
    onToggleStar: () => void;
}) {
    if (!tile.card) {
        return (
            <div className="aspect-[3/4] border border-border rounded p-2 opacity-50 flex flex-col gap-1 overflow-hidden">
                <div className="flex items-center gap-1 text-amber-400 text-[10px] uppercase tracking-wider">
                    <AlertTriangle size={11} /> Not a card
                </div>
                <div className="text-[10px] text-text-primary truncate" title={tile.fileName}>{tile.fileName}</div>
                <div className="text-[10px] text-text-dim leading-snug">
                    {FAILURE_COPY[tile.failure ?? 'not-card'] ?? FAILURE_COPY['not-card']}
                </div>
                {hint && <div className="text-[10px] text-text-dim leading-snug">{hint}</div>}
            </div>
        );
    }

    const seedable = canSeed(tile.card);
    const spec = tile.card.spec.toUpperCase();
    return (
        <div
            className={`relative border rounded p-1.5 flex flex-col gap-1 transition-transform ${
                tile.star ? 'border-terminal ring-1 ring-terminal scale-[1.02]' : 'border-border'
            }`}
        >
            <div className="aspect-[3/4] bg-void border border-border rounded overflow-hidden flex items-center justify-center">
                {thumb
                    ? <img src={thumb} alt="" className="w-full h-full object-cover" />
                    : <User size={22} className="text-text-dim" />}
            </div>
            <div className="flex items-center justify-between gap-1">
                <span className="text-[11px] text-text-primary truncate" title={tile.card.name}>{tile.card.name}</span>
                <span className="text-[9px] text-text-dim border border-border rounded px-1">{spec}</span>
            </div>
            {tile.persona && <div className="text-[9px] text-terminal">👤 This is me</div>}
            {tile.star && (
                <div className="text-[9px] text-terminal uppercase tracking-wider leading-snug">{SEED_RIBBON}</div>
            )}
            <button
                type="button"
                onClick={onToggleStar}
                disabled={!seedable}
                title={seedable ? SEED_HINT : NO_SEED_TOOLTIP}
                aria-label={`Campaign seed: ${tile.card.name}`}
                className={`absolute top-2 right-2 p-1 rounded ${
                    tile.star ? 'text-terminal' : 'text-text-dim hover:text-terminal'
                } disabled:opacity-30 disabled:cursor-not-allowed`}
            >
                <Star size={14} fill={tile.star ? 'currentColor' : 'none'} />
            </button>
        </div>
    );
}

function GreetingStep({ card, value, onChange }: { card: STCard; value: number; onChange: (n: number) => void }) {
    const options = [card.first_mes, ...card.alternate_greetings];
    return (
        <div className="space-y-2 max-w-2xl">
            <p className="text-[11px] text-text-dim">
                This card ships more than one opening. Pick the one the campaign starts on.
            </p>
            {options.map((text, i) => (
                <label key={i} className="flex items-start gap-2 cursor-pointer border border-border rounded p-2 hover:border-terminal transition-colors">
                    <input
                        type="radio"
                        name="st-greeting"
                        checked={value === i}
                        onChange={() => onChange(i)}
                        className="mt-0.5"
                    />
                    <span className="text-[11px] text-text-dim leading-snug">
                        <span className="text-terminal uppercase tracking-wider mr-2">
                            {i === 0 ? 'First message' : `Alternate ${i}`}
                        </span>
                        {text.slice(0, 120)}{text.length > 120 ? '…' : ''}
                    </span>
                </label>
            ))}
        </div>
    );
}

function SummaryBlock({ plan }: { plan: ImportPlan }) {
    const { summary } = plan;
    const lines: string[] = [];
    if (summary.inferredFromTags.length > 0) {
        lines.push(`Personality inferred from tags (not authored): ${summary.inferredFromTags.join(', ')}.`);
    }
    if (summary.structuredDescriptions.length > 0) {
        lines.push(`Structured (W++) description, read as trait lines: ${summary.structuredDescriptions.join(', ')}.`);
    }
    if (summary.constantDemoted > 0) {
        lines.push(`${summary.constantDemoted} constant lore entries routed to searchable memory. Re-promote any of them in the Lore tab.`);
    }
    if (summary.overwrittenDuplicates.length > 0) {
        lines.push(`Overwritten by a later card in this drop: ${summary.overwrittenDuplicates.join(', ')}.`);
    }
    if (summary.skippedDuplicates.length > 0) {
        lines.push(`Skipped as duplicates: ${summary.skippedDuplicates.join(', ')}.`);
    }
    if (summary.personaNameCollision) {
        lines.push("this card shares your character's name");
    }
    if (lines.length === 0) return null;
    return (
        <div className="border border-border rounded p-3 space-y-1">
            <div className={LABEL}>What the import did</div>
            {lines.map(line => (
                <p key={line} className="text-[11px] text-text-dim leading-relaxed">{line}</p>
            ))}
        </div>
    );
}

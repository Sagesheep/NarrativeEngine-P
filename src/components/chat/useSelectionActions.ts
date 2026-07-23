import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../Toast';
import { addNpcFromSelection } from '../../services/npc/manualAdd';
import { isLikelyFeatureLabel, parseLocationHeader, resolveLocationHeader } from '../../services/locationHeader';
import { queueLocationEnrichment } from '../../services/locationEnrich';

import { buildSceneImageContextInput } from '../../services/scene-images/sceneImageContextGatherer';
import { composeSceneImageAPI } from '../../services/sceneImagesClient';

export type SelectionSnapshot = {
    messageId: string;
    text: string;
    start: number;
    end: number;
    bubbleText: string;
};

export const stripMarkdown = (s: string) => s.replace(/\*\*/g, '').replace(/\*/g, '').trim();

const captureFromBubble = (selector: string): SelectionSnapshot | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);

    // Reject selections spanning multiple nodes across different bubbles
    const startBubble = (range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement)?.closest('[data-message-id]');
    const endBubble = (range.endContainer.nodeType === 1 ? range.endContainer as Element : range.endContainer.parentElement)?.closest('[data-message-id]');
    if (startBubble && endBubble && startBubble !== endBubble) {
        return null;
    }

    const node = range.commonAncestorContainer;
    const el = (node.nodeType === 1 ? node as Element : node.parentElement);
    const bubble = el?.closest(selector) as HTMLElement | null;
    if (!bubble) return null;
    const messageId = bubble.dataset.messageId;
    const text = sel.toString().trim();
    if (!messageId || text.length < 1) return null;
    const bubbleText = bubble.textContent ?? '';
    let start = bubbleText.indexOf(text);
    if (start === -1) {
        const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
        start = norm(bubbleText).indexOf(norm(text));
    }
    if (start === -1) start = 0;
    return { messageId, text, start, end: start + text.length, bubbleText };
};

/**
 * Selection-menu state machine + selected-text actions (Lore Check, Pin Memory,
 * Rename, Add NPC, Add Place, Generate Scene Image).
 */
export function useSelectionActions() {
    const openLoreCheck = useAppStore(s => s.openLoreCheck);
    const addPinnedExcerpt = useAppStore(s => s.addPinnedExcerpt);
    const openRenameModal = useAppStore(s => s.openRenameModal);
    const openSceneImageModal = useAppStore(s => s.openSceneImageModal);
    const updateSceneImageDraft = useAppStore(s => s.updateSceneImageDraft);

    const [loreSel, setLoreSel] = useState<SelectionSnapshot | null>(null);
    const [pinSel, setPinSel] = useState<SelectionSnapshot | null>(null);
    const [renameSel, setRenameSel] = useState<SelectionSnapshot | null>(null);
    const [npcSel, setNpcSel] = useState<SelectionSnapshot | null>(null);
    const [npcAdding, setNpcAdding] = useState(false);
    const selectionMenuRef = useRef<HTMLDivElement>(null);
    const [selectionMenuPosition, setSelectionMenuPosition] = useState<{ left: number; top: number } | null>(null);

    useEffect(() => {
        const handle = () => {
            const state = useAppStore.getState();
            // In-flight turn guard: do not show toolbar while a turn is generating
            if (state.pipelinePhase !== 'idle' || state.isStreaming) {
                setSelectionMenuPosition(null);
                return;
            }

            const lore = captureFromBubble('[data-lore-checkable="true"]');
            setLoreSel(lore);
            setPinSel(captureFromBubble('[data-message-id]'));
            setRenameSel(captureFromBubble('[data-message-id]'));
            setNpcSel(lore);

            const selection = window.getSelection();
            if (!lore || !selection?.rangeCount) {
                setSelectionMenuPosition(null);
                return;
            }

            const rect = selection.getRangeAt(0).getBoundingClientRect();
            const menuWidth = Math.min(640, window.innerWidth - 24);
            const menuHeight = 88;
            const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - menuWidth - 12));
            const below = rect.bottom + 10;
            const top = below + menuHeight <= window.innerHeight - 12
                ? below
                : Math.max(12, rect.top - menuHeight - 10);
            setSelectionMenuPosition({ left, top });
        };
        const dismissOnOutsidePointer = (event: PointerEvent) => {
            if (!selectionMenuRef.current?.contains(event.target as Node)) {
                setSelectionMenuPosition(null);
            }
        };
        const dismissOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setSelectionMenuPosition(null);
        };
        const dismiss = () => setSelectionMenuPosition(null);
        document.addEventListener('selectionchange', handle);
        document.addEventListener('pointerdown', dismissOnOutsidePointer);
        document.addEventListener('keydown', dismissOnEscape);
        window.addEventListener('resize', dismiss);
        window.addEventListener('scroll', dismiss, true);
        return () => {
            document.removeEventListener('selectionchange', handle);
            document.removeEventListener('pointerdown', dismissOnOutsidePointer);
            document.removeEventListener('keydown', dismissOnEscape);
            window.removeEventListener('resize', dismiss);
            window.removeEventListener('scroll', dismiss, true);
        };
    }, []);

    const handleLoreCheck = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-lore-checkable="true"]') ?? loreSel;
        if (!snap) {
            toast.info('Highlight text in a GM message first to check lore.');
            return;
        }
        const before = snap.bubbleText.slice(Math.max(0, snap.start - 200), snap.start);
        const after = snap.bubbleText.slice(snap.end, Math.min(snap.bubbleText.length, snap.end + 200));
        openLoreCheck({
            messageId: snap.messageId, selectedText: stripMarkdown(snap.text),
            start: snap.start, end: snap.end,
            surroundingContext: `${before}[[HIGHLIGHTED]]${snap.text}[[/HIGHLIGHTED]]${after}`,
        });
        window.getSelection()?.removeAllRanges();
        setLoreSel(null);
        setPinSel(null);
    };

    const handlePinSelection = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-message-id]') ?? pinSel;
        if (!snap) {
            toast.info('Highlight text in a message first to pin a memory.');
            return;
        }
        const result = addPinnedExcerpt(snap.messageId, snap.text, false);
        if (result.ok) {
            window.getSelection()?.removeAllRanges();
            setPinSel(null);
            setLoreSel(null);
        } else {
            toast.warning(result.reason);
        }
    };

    const handleRenameSelection = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-message-id]') ?? renameSel;
        if (!snap) {
            toast.info('Highlight a name/text in a message first to rename.');
            return;
        }
        openRenameModal(stripMarkdown(snap.text));
        window.getSelection()?.removeAllRanges();
        setRenameSel(null);
        setPinSel(null);
        setLoreSel(null);
    };

    const handleAddNpc = async (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        if (npcAdding) return;
        const snap = captureFromBubble('[data-lore-checkable="true"]') ?? npcSel;
        if (!snap) {
            toast.info('Highlight a name in a GM message first to add/update an NPC.');
            return;
        }
        const state = useAppStore.getState();
        const campaignId = state.activeCampaignId;
        if (!campaignId) { toast.warning('No active campaign.'); return; }

        window.getSelection()?.removeAllRanges();
        setNpcSel(null);
        setLoreSel(null);
        setPinSel(null);
        setNpcAdding(true);
        const cleanName = stripMarkdown(snap.text);
        toast.info(`Resolving "${cleanName}"…`);
        try {
            const result = await addNpcFromSelection({
                rawText: cleanName,
                ledger: state.npcLedger ?? [],
                messages: state.messages,
                campaignId,
                storyProvider: state.getActiveStoryEndpoint(),
                updateProvider: state.getActiveSummarizerEndpoint() ?? state.getActiveUtilityEndpoint() ?? state.getActiveStoryEndpoint(),
                addNPC: state.addNPC,
                updateNPC: state.updateNPC,
            });
            if (result.ok) toast.success(result.message);
            else if (result.kind === 'ambiguous') toast.warning(result.message);
            else toast.error(result.message);
        } catch (err) {
            toast.error(`Add NPC failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setNpcAdding(false);
        }
    };

    const handleAddPlace = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-lore-checkable="true"]') ?? npcSel;
        if (!snap) {
            toast.info('Highlight a place name in a GM message first to add it.');
            return;
        }
        const state = useAppStore.getState();
        if (!state.activeCampaignId) { toast.warning('No active campaign.'); return; }

        window.getSelection()?.removeAllRanges();
        setNpcSel(null);
        setLoreSel(null);
        setPinSel(null);
        const cleanName = stripMarkdown(snap.text).trim();
        if (!cleanName || cleanName.length > 80) {
            toast.info('Couldn’t read a place name from the selection.');
            return;
        }
        const ledger = state.locationLedger ?? [];
        let anchorId = state.context.currentPlaceId ?? null;

        const currentEntry = anchorId ? ledger.find(l => l.id === anchorId) : undefined;
        if (currentEntry) {
            const canonical = resolveLocationHeader(
                currentEntry.name,
                ledger.filter(l => l.id !== currentEntry.id),
                null,
            );
            if (canonical.kind === 'resolved') anchorId = canonical.placeId;
        }

        const manualHeader = cleanName.includes('📍') ? cleanName : `📍 ${cleanName}`;
        const outcome = resolveLocationHeader(manualHeader, ledger, anchorId);
        const now = String(Date.now());

        if (outcome.kind === 'resolved') {
            const place = ledger.find(l => l.id === outcome.placeId);
            if (!place) return;
            if (outcome.appendFeature && outcome.feature) {
                state.updateLocation(place.id, {
                    features: [...place.features, outcome.feature],
                    lastSeenScene: now,
                });
            }
            state.updateContext({ currentPlaceId: place.id, currentFeature: outcome.feature });
            toast.success(outcome.feature
                ? `Current place: ${place.name} — ${outcome.feature}`
                : `Current place set: ${place.name}`);
            return;
        }

        if (outcome.kind === 'feature-only' && anchorId) {
            const place = ledger.find(l => l.id === anchorId);
            if (!place) return;
            if (outcome.appendFeature) {
                state.updateLocation(place.id, {
                    features: [...place.features, outcome.feature],
                    lastSeenScene: now,
                });
            }
            state.updateContext({ currentPlaceId: place.id, currentFeature: outcome.feature });
            toast.success(`${outcome.appendFeature ? 'Added' : 'Selected'} feature "${outcome.feature}" in ${place.name}.`);
            return;
        }

        const newName = outcome.kind === 'unknown' ? outcome.suggestion.name : cleanName;
        const rawManual = parseLocationHeader(manualHeader) ?? cleanName;
        const suffix = rawManual.toLowerCase().startsWith(newName.toLowerCase())
            ? rawManual.slice(newName.length).replace(/^[\s—–,:-]+/, '').trim()
            : '';
        const initialFeature = isLikelyFeatureLabel(suffix) ? suffix : null;
        const loc = {
            id: `loc_${now}_${Math.random().toString(36).slice(2, 7)}`,
            name: newName,
            aliases: '',
            broadLocation: '',
            features: initialFeature ? [initialFeature] : [],
            connections: [],
            description: '',
            firstSeenScene: now,
            lastSeenScene: now,
            source: 'manual' as const,
        };
        state.addLocation(loc);
        state.updateContext({ currentPlaceId: loc.id, currentFeature: initialFeature });
        state.dismissLocationSuggestion(newName);
        toast.success(initialFeature
            ? `Added "${newName}" with feature "${initialFeature}" and set it current.`
            : `Added "${newName}" and set as current place.`);
        queueLocationEnrichment(loc.id);
    };

    const handleGenerateSceneImage = async (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-lore-checkable="true"]') ?? loreSel;
        if (!snap) {
            toast.info('Highlight text in a GM message first to generate a scene image.');
            return;
        }
        const state = useAppStore.getState();
        const campaignId = state.activeCampaignId;
        if (!campaignId) {
            toast.warning('No active campaign.');
            return;
        }

        window.getSelection()?.removeAllRanges();
        setLoreSel(null);
        setNpcSel(null);
        setPinSel(null);

        const contextInput = buildSceneImageContextInput(
            snap.messageId,
            stripMarkdown(snap.text),
            snap.start,
            snap.end
        );

        openSceneImageModal({
            campaignId,
            sourceMessageId: snap.messageId,
            selectedText: stripMarkdown(snap.text),
            selectedTextOffsets: { start: snap.start, end: snap.end },
            contextInput,
            isComposing: true,
            isGenerating: false,
        });

        try {
            const composedPackage = await composeSceneImageAPI(campaignId, contextInput);
            updateSceneImageDraft({
                promptPackage: {
                    focus: composedPackage.focus,
                    positivePrompt: composedPackage.positivePrompt,
                    negativePrompt: composedPackage.negativePrompt,
                    style: composedPackage.style || 'Cinematic illustration',
                    framing: composedPackage.framing || 'Wide scene',
                    aspectRatio: composedPackage.aspectRatio || '16:9',
                },
                sceneContextSummary: composedPackage.sceneContextSummary,
                isComposing: false,
            });
        } catch (err) {
            console.error('[SceneImage] Composition failed:', err);
            updateSceneImageDraft({
                isComposing: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    };

    return {
        loreSel,
        npcAdding,
        selectionMenuRef,
        selectionMenuPosition,
        handleLoreCheck,
        handlePinSelection,
        handleRenameSelection,
        handleAddNpc,
        handleAddPlace,
        handleGenerateSceneImage,
    };
}


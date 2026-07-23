import { useState, useEffect } from 'react';
import { X, Sparkles, Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { composeSceneImageAPI, generateSceneImageAPI } from '../../services/sceneImagesClient';
import { toast } from '../Toast';
import type { SceneImageAspect } from '../../types';

export function SceneImageModal() {
    const isOpen = useAppStore(s => s.sceneImageModalOpen);
    const draft = useAppStore(s => s.sceneImageDraft);
    const close = useAppStore(s => s.closeSceneImageModal);
    const updateDraft = useAppStore(s => s.updateSceneImageDraft);
    const setComposing = useAppStore(s => s.setComposingSceneImage);
    const setGenerating = useAppStore(s => s.setGeneratingSceneImage);
    const addAttachment = useAppStore(s => s.addMessageAttachment);

    const [selectedMoment, setSelectedMoment] = useState('');
    const [sceneContext, setSceneContext] = useState('');
    const [positivePrompt, setPositivePrompt] = useState('');
    const [negativePrompt, setNegativePrompt] = useState('');
    const [style, setStyle] = useState('Cinematic illustration');
    const [framing, setFraming] = useState('Wide scene');
    const [aspectRatio, setAspectRatio] = useState<SceneImageAspect>('16:9');
    const [errorMsg, setErrorMsg] = useState('');

    useEffect(() => {
        if (draft) {
            setSelectedMoment(draft.selectedText || '');
            setSceneContext(draft.sceneContextSummary || draft.contextInput?.activeScene?.location || '');
            if (draft.promptPackage) {
                setPositivePrompt(draft.promptPackage.positivePrompt || '');
                setNegativePrompt(draft.promptPackage.negativePrompt || '');
                setStyle(draft.promptPackage.style || 'Cinematic illustration');
                setFraming(draft.promptPackage.framing || 'Wide scene');
                setAspectRatio(draft.promptPackage.aspectRatio || '16:9');
            }
            if (draft.error) {
                setErrorMsg(draft.error);
            } else {
                setErrorMsg('');
            }
        }
    }, [draft]);

    if (!isOpen || !draft) return null;

    const handleRebuild = async () => {
        if (draft.isComposing || draft.isGenerating) return;
        setErrorMsg('');
        setComposing(true);
        try {
            const updatedInput = {
                ...draft.contextInput,
                selectedText: selectedMoment,
            };
            const result = await composeSceneImageAPI(draft.campaignId, updatedInput);
            setPositivePrompt(result.positivePrompt);
            setNegativePrompt(result.negativePrompt);
            setStyle(result.style || 'Cinematic illustration');
            setFraming(result.framing || 'Wide scene');
            setAspectRatio(result.aspectRatio || '16:9');
            setSceneContext(result.sceneContextSummary);
            updateDraft({
                sceneContextSummary: result.sceneContextSummary,
                promptPackage: {
                    focus: result.focus,
                    positivePrompt: result.positivePrompt,
                    negativePrompt: result.negativePrompt,
                    style: result.style,
                    framing: result.framing,
                    aspectRatio: result.aspectRatio,
                },
                isComposing: false,
            });
            toast.success('Prompt rebuilt from story context.');
        } catch (err) {
            console.error('[SceneImageModal] Rebuild failed:', err);
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMsg(msg);
            toast.error(`Rebuild failed: ${msg}`);
            setComposing(false);
        }
    };

    const handleGenerate = async () => {
        if (draft.isGenerating || draft.isComposing) return;
        if (!positivePrompt.trim()) {
            toast.warning('Visual prompt cannot be empty.');
            return;
        }

        setErrorMsg('');
        setGenerating(true);

        const promptPackage = {
            focus: selectedMoment.slice(0, 100),
            positivePrompt: positivePrompt.trim(),
            negativePrompt: negativePrompt.trim() || undefined,
            style,
            framing,
            aspectRatio,
        };

        try {
            const attachment = await generateSceneImageAPI({
                campaignId: draft.campaignId,
                sourceMessageId: draft.sourceMessageId,
                selectedText: selectedMoment,
                selectionStart: draft.selectedTextOffsets?.start,
                selectionEnd: draft.selectedTextOffsets?.end,
                promptPackage,
            });

            addAttachment(draft.sourceMessageId, attachment);
            toast.success('Scene image generated successfully!');
            close();
        } catch (err) {
            console.error('[SceneImageModal] Generation failed:', err);
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMsg(msg);
            toast.error(`Generation failed: ${msg}`);
        } finally {
            setGenerating(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-void-darker/80 p-4 backdrop-blur-sm animate-[fadeIn_0.15s_ease-out]">
            <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border border-cyan-500/40 bg-void-darker shadow-2xl overflow-hidden font-mono">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-cyan-500/20 bg-void-lighter/60 px-5 py-3.5">
                    <div className="flex items-center gap-2">
                        <Sparkles size={16} className="text-cyan-400" />
                        <h2 className="text-sm font-bold uppercase tracking-wider text-cyan-300">Generate Scene Image</h2>
                    </div>
                    <button
                        onClick={close}
                        disabled={draft.isGenerating}
                        className="rounded p-1 text-text-dim hover:bg-void-lighter hover:text-text-primary transition-colors"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="px-5 py-2 bg-cyan-950/30 border-b border-cyan-500/10 text-[10px] text-cyan-400/90 tracking-wide">
                    Changes here affect the image only; they do not change your story.
                </div>

                {/* Content Body */}
                <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
                    {draft.isComposing ? (
                        <div className="flex flex-col items-center justify-center py-12 space-y-3">
                            <Loader2 size={24} className="animate-spin text-cyan-400" />
                            <p className="text-cyan-300 font-bold uppercase tracking-widest text-[11px] animate-pulse">
                                Preparing scene details…
                            </p>
                            <p className="text-[10px] text-text-dim max-w-xs text-center">
                                Story AI is extracting scene context and drafting positive/negative prompts.
                            </p>
                        </div>
                    ) : (
                        <>
                            {errorMsg && (
                                <div className="flex items-start gap-2 p-3 bg-red-950/40 border border-red-500/30 rounded text-red-300 text-[11px]">
                                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                                    <div className="flex-1">
                                        <div className="font-bold">Generation Error</div>
                                        <div>{errorMsg}</div>
                                    </div>
                                </div>
                            )}

                            {/* 1. Selected moment */}
                            <div>
                                <label className="block mb-1 text-[10px] uppercase tracking-wider text-text-dim font-bold">
                                    Selected Moment
                                </label>
                                <textarea
                                    value={selectedMoment}
                                    onChange={(e) => setSelectedMoment(e.target.value)}
                                    rows={2}
                                    className="w-full rounded border border-terminal/40 bg-void-lighter/90 px-3 py-2 text-xs text-text-primary focus:border-cyan-400 focus:outline-none"
                                />
                            </div>

                            {/* 2. Scene context */}
                            <div>
                                <label className="block mb-1 text-[10px] uppercase tracking-wider text-text-dim font-bold">
                                    Scene Context
                                </label>
                                <textarea
                                    value={sceneContext}
                                    onChange={(e) => setSceneContext(e.target.value)}
                                    rows={2}
                                    className="w-full rounded border border-terminal/40 bg-void-lighter/90 px-3 py-2 text-xs text-text-primary focus:border-cyan-400 focus:outline-none"
                                />
                            </div>

                            {/* 3. Visual prompt */}
                            <div>
                                <label className="block mb-1 text-[10px] uppercase tracking-wider text-text-dim font-bold">
                                    Visual Prompt
                                </label>
                                <textarea
                                    value={positivePrompt}
                                    onChange={(e) => setPositivePrompt(e.target.value)}
                                    rows={3}
                                    placeholder="Description of the scene..."
                                    className="w-full rounded border border-terminal/40 bg-void-lighter/90 px-3 py-2 text-xs text-text-primary focus:border-cyan-400 focus:outline-none"
                                />
                            </div>

                            {/* 4. Avoid */}
                            <div>
                                <label className="block mb-1 text-[10px] uppercase tracking-wider text-text-dim font-bold">
                                    Avoid (Negative Prompt)
                                </label>
                                <textarea
                                    value={negativePrompt}
                                    onChange={(e) => setNegativePrompt(e.target.value)}
                                    rows={2}
                                    placeholder="Elements to exclude..."
                                    className="w-full rounded border border-terminal/40 bg-void-lighter/90 px-3 py-2 text-xs text-text-primary focus:border-cyan-400 focus:outline-none"
                                />
                            </div>

                            {/* Options Row */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                                {/* Style */}
                                <div>
                                    <label className="block mb-1 text-[10px] uppercase tracking-wider text-text-dim font-bold">
                                        Style
                                    </label>
                                    <select
                                        value={style}
                                        onChange={(e) => setStyle(e.target.value)}
                                        className="w-full rounded border border-terminal/40 bg-void-lighter px-2.5 py-1.5 text-xs text-text-primary focus:border-cyan-400 focus:outline-none"
                                    >
                                        <option value="Cinematic illustration">Cinematic illustration</option>
                                        <option value="Anime-inspired">Anime-inspired</option>
                                        <option value="Painterly fantasy">Painterly fantasy</option>
                                        <option value="Realistic">Realistic</option>
                                    </select>
                                </div>

                                {/* Framing */}
                                <div>
                                    <label className="block mb-1 text-[10px] uppercase tracking-wider text-text-dim font-bold">
                                        Framing
                                    </label>
                                    <select
                                        value={framing}
                                        onChange={(e) => setFraming(e.target.value)}
                                        className="w-full rounded border border-terminal/40 bg-void-lighter px-2.5 py-1.5 text-xs text-text-primary focus:border-cyan-400 focus:outline-none"
                                    >
                                        <option value="Wide scene">Wide scene</option>
                                        <option value="Character moment">Character moment</option>
                                        <option value="Establishing shot">Establishing shot</option>
                                    </select>
                                </div>

                                {/* Aspect ratio */}
                                <div>
                                    <label className="block mb-1 text-[10px] uppercase tracking-wider text-text-dim font-bold">
                                        Aspect Ratio
                                    </label>
                                    <div className="flex items-center gap-1">
                                        {(['16:9', '1:1', '9:16'] as SceneImageAspect[]).map((ar) => (
                                            <button
                                                key={ar}
                                                type="button"
                                                onClick={() => setAspectRatio(ar)}
                                                className={`flex-1 rounded border px-2 py-1.5 text-[10px] uppercase tracking-wider transition-colors ${aspectRatio === ar
                                                        ? 'border-cyan-400 bg-cyan-950/60 text-cyan-200 font-bold'
                                                        : 'border-terminal/40 bg-void-lighter text-text-dim hover:text-text-primary'
                                                    }`}
                                            >
                                                {ar}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* Footer Actions */}
                <div className="flex items-center justify-between border-t border-cyan-500/20 bg-void-lighter/60 px-5 py-3">
                    <button
                        onClick={handleRebuild}
                        disabled={draft.isComposing || draft.isGenerating}
                        className="flex items-center gap-1.5 rounded border border-terminal/40 bg-void-lighter px-3 py-1.5 text-[11px] uppercase tracking-wider text-text-dim hover:border-terminal hover:text-text-primary transition-colors disabled:opacity-50"
                    >
                        <RefreshCw size={12} className={draft.isComposing ? 'animate-spin' : ''} />
                        Rebuild from story
                    </button>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={close}
                            disabled={draft.isGenerating}
                            className="rounded border border-terminal/40 px-3 py-1.5 text-[11px] uppercase tracking-wider text-text-dim hover:text-text-primary transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleGenerate}
                            disabled={draft.isComposing || draft.isGenerating}
                            className="flex items-center gap-1.5 rounded border border-cyan-400 bg-cyan-950/80 px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider text-cyan-200 hover:bg-cyan-500/30 transition-colors disabled:opacity-50"
                        >
                            {draft.isGenerating ? (
                                <>
                                    <Loader2 size={13} className="animate-spin text-cyan-300" />
                                    Generating…
                                </>
                            ) : (
                                <>
                                    <Sparkles size={13} />
                                    Generate Image
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

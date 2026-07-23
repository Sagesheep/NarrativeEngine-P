import { useEffect, useMemo, useState } from 'react';
import { X, Wand2, Loader2, AlertTriangle, ChevronRight, ChevronLeft, Check } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { CharacterCreationDraft, CreationSlot, NPCVisualProfile, EndpointConfig, ProviderConfig } from '../../types';
import { DEFAULT_VISUAL_PROFILE } from '../../types';
import { resolveGuidedCreationEndpoint, listCreationHeaders } from '../../services/character/loreExcerptBuilder';
import { generateInterviewQuestions, runQuestionPrompt, convertInterviewAnswers, type GuidedProgress } from '../../services/character/aiGuidedGeneration';
import { drawScenarios, deriveHexFromAnswers, type QuizScenario } from '../../services/character/hexQuiz';
import { commitCharacterDraft } from '../../services/character/commitCharacterDraft';
import { hexBand } from '../../services/npc/agency/agencyBands';
import { toast } from '../Toast';

type Phase = 'idle' | 'generating-questions' | 'answering' | 'hex-choice' | 'quiz' | 'converting' | 'clarifying' | 'reveal';

const ANSWER_SLOTS: CreationSlot[] = [2, 3, 4, 5, 6, 7, 8];

const PRIMARY_VISUAL_FIELDS: (keyof NPCVisualProfile)[] = ['race', 'gender', 'ageRange', 'build', 'hairStyle', 'eyeColor'];
const SECONDARY_VISUAL_FIELDS: (keyof NPCVisualProfile)[] = ['symmetry', 'skinTone', 'gait', 'distinctMarks', 'clothing', 'artStyle'];

/**
 * WO-A2 §2 — AI-Guided Creation wizard.
 *
 * Mounts inside `CharacterLedgerModal` when the user picks "AI-Guided
 * Creation" from the Sheet tab's empty-state chooser. Runs the 9-slot
 * interview flow end-to-end:
 *
 *   1. Endpoint + lore selection (zero LLM) — disabled with a visible reason
 *      when no lore chunks exist or no endpoint resolves.
 *   2. LLM call 1 (split: slots 2–5, then 6–8) — AI reskins wording only.
 *      Engine owns the slot/field map; the model never sees it.
 *   3. Answering — user answers all 9 slots offline. No LLM call fires here.
 *      Draft persisted to `context.creationDraft` on every step.
 *   4. Hex + traits choice — Manual / Questionnaire / Skip.
 *   5. Quiz (LLM-free) — weighted multiple choice, deterministic.
 *   6. LLM call 2 — convert prose answers; at most 3 clarifying questions.
 *   7. Reveal + commit — engine-computed (no LLM); one commit path.
 *
 * The failure ladder (§2.4) never dead-ends: zero lore → unavailable message;
 * one failure → retry once; second failure → drop into Manual.
 */
export function AIGuidedCreationWizard({ onCancel, onCommit }: { onCancel: () => void; onCommit: () => void }) {
    const context = useAppStore(s => s.context);
    const updateContext = useAppStore(s => s.updateContext);
    const loreChunks = useAppStore(s => s.loreChunks);
    const setPlayerCharacter = useAppStore(s => s.setPlayerCharacter);
    const setInventoryItems = useAppStore(s => s.setInventoryItems);
    const characterProfileData = useAppStore(s => s.characterProfileData);
    // Context-window size drives the 20%-floored excerpt budget (floor 1200).
    const maxContextTokens = useAppStore(s => s.settings.contextLimit);

    // Endpoint + lore availability (§2.2).
    const provider = useMemo<EndpointConfig | ProviderConfig | undefined>(() => {
        return resolveGuidedCreationEndpoint(
            () => useAppStore.getState().getActiveUtilityEndpoint(),
            () => useAppStore.getState().getActiveAuxiliaryEndpoint(),
            () => useAppStore.getState().getActiveSummarizerEndpoint(),
            () => useAppStore.getState().getActiveStoryEndpoint(),
        );
    }, []);

    // Eligible sections for the header pre-pass (non-character chunks). This is
    // the real gate — the AI picks from these, falling back to the category
    // excerpt only if the pick fails.
    const eligibleCount = useMemo(() => listCreationHeaders(loreChunks ?? []).length, [loreChunks]);
    const canRun = !!provider && eligibleCount > 0;

    // Draft state — persisted to `context.creationDraft` on every change.
    const draft0 = context.creationDraft ?? emptyDraft();
    const [draft, setDraft] = useState<CharacterCreationDraft>(draft0);
    const [phase, setPhase] = useState<Phase>(draft0.step ? resumePhase(draft0.step) : 'idle');
    const [error, setError] = useState<string | null>(null);
    const [retryCount, setRetryCount] = useState(0);
    const [elapsed, setElapsed] = useState(0);
    const [scenarios, setScenarios] = useState<QuizScenario[]>([]);
    const [quizAnswers, setQuizAnswers] = useState<Record<number, number>>({});
    const [convertedAnswers, setConvertedAnswers] = useState<Partial<Record<CreationSlot, string>>>({});
    const [clarifyingQuestions, setClarifyingQuestions] = useState<string[]>([]);
    const [clarifyingAnswers, setClarifyingAnswers] = useState<string[]>([]);
    const [committedHex, setCommittedHex] = useState<import('../../types').PersonalityHex | undefined>();
    const [committedTraits, setCommittedTraits] = useState<string[] | undefined>();

    // Live streaming state — the "Sent to AI" + thinking/answer panel.
    const [sentPrompt, setSentPrompt] = useState('');
    const [editablePrompt, setEditablePrompt] = useState('');
    const [liveReasoning, setLiveReasoning] = useState('');
    const [liveContent, setLiveContent] = useState('');
    const [streamDone, setStreamDone] = useState(false);
    const [liveStage, setLiveStage] = useState<GuidedProgress['stage']>('questions');
    const [pendingDraft, setPendingDraft] = useState<CharacterCreationDraft | null>(null);

    const onProgress = (p: GuidedProgress) => {
        setLiveStage(p.stage);
        setSentPrompt(p.prompt);
        setLiveReasoning(p.reasoning);
        setLiveContent(p.content);
    };

    // Persist draft on every change (§2.5).
    useEffect(() => {
        updateContext({ creationDraft: { ...draft, step: phaseToStep(phase) } } as never);
    }, [draft, phase, updateContext]);

    // Progress elapsed timer.
    useEffect(() => {
        if (phase !== 'generating-questions' && phase !== 'converting') return;
        const start = Date.now();
        const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
        return () => clearInterval(id);
    }, [phase]);

    if (!canRun && phase === 'idle') {
        return <UnavailableState reason={!provider ? 'no-endpoint' : 'no-lore'} onCancel={onCancel} />;
    }

    const start = async () => {
        setError(null);
        setStreamDone(false);
        setLiveReasoning('');
        setLiveContent('');
        setSentPrompt('');
        setPendingDraft(null);
        setLiveStage('lore-select');
        setPhase('generating-questions');
        setElapsed(0);
        const result = await generateInterviewQuestions(provider!, loreChunks ?? [], draft, { onProgress, maxContextTokens });
        if (result.ok) {
            // Do NOT auto-advance — hold on the panel so the user can review the
            // prompt + thinking, edit the prompt, and re-run before committing.
            setPendingDraft(result.draft);
            setEditablePrompt(result.sentPrompt);
            setStreamDone(true);
        } else {
            handleGenerationFailure(result);
        }
    };

    // Editable "Sent to AI" → re-run with the user's modified prompt.
    const rerunQuestions = async () => {
        setError(null);
        setStreamDone(false);
        setLiveReasoning('');
        setLiveContent('');
        setPendingDraft(null);
        setLiveStage('questions');
        setElapsed(0);
        const result = await runQuestionPrompt(provider!, editablePrompt, draft, { onProgress, maxContextTokens });
        if (result.ok) {
            setPendingDraft(result.draft);
            setStreamDone(true);
        } else {
            handleGenerationFailure(result);
        }
    };

    const continueToAnswering = () => {
        if (pendingDraft) setDraft(pendingDraft);
        setStreamDone(false);
        setPhase('answering');
    };

    const handleGenerationFailure = (result: { ok: false; reason: string; retryable: boolean }) => {
        if (!result.retryable) {
            setError(unavailableMessage(result.reason));
            setPhase('idle');
            return;
        }
        if (retryCount === 0) {
            setRetryCount(1);
            setError('AI was unable to read your world lore. Try again?');
            setPhase('idle');
        } else {
            // Second failure — drop into Manual (§2.4 failure ladder).
            toast.error('AI guidance unavailable — dropping into Manual creation.');
            onCancel();
        }
    };

    const proceedToHexChoice = () => {
        if (!draft.name?.trim()) {
            toast.error('Your character needs a name.');
            return;
        }
        setPhase('hex-choice');
    };

    const startQuiz = () => {
        const drawn = drawScenarios();
        setScenarios(drawn);
        setQuizAnswers({});
        setPhase('quiz');
    };

    const finishQuiz = () => {
        const { hex, traits } = deriveHexFromAnswers(scenarios, quizAnswers);
        setCommittedHex(hex);
        setCommittedTraits(traits);
        setDraft(d => ({ ...d, hexMode: 'questionnaire', quizAnswers }));
        setPhase('converting');
        void runConversion();
    };

    const skipHex = () => {
        setCommittedHex(undefined);
        setCommittedTraits(undefined);
        setDraft(d => ({ ...d, hexMode: 'skip' }));
        setPhase('converting');
        void runConversion();
    };

    const useManualHex = () => {
        // Manual path: drop into the Sheet tab's hex chevrons. The wizard
        // commits with no hex; the user adjusts on the sheet afterward.
        setCommittedHex(undefined);
        setCommittedTraits(undefined);
        setDraft(d => ({ ...d, hexMode: 'manual' }));
        setPhase('converting');
        void runConversion();
    };

    const runConversion = async () => {
        setElapsed(0);
        setStreamDone(false);
        setLiveReasoning('');
        setLiveContent('');
        setLiveStage('convert');
        const result = await convertInterviewAnswers(provider!, draft, loreChunks ?? [], { onProgress, maxContextTokens });
        if (result.ok) {
            setConvertedAnswers(result.convertedAnswers);
            setClarifyingQuestions(result.clarifyingQuestions);
            setClarifyingAnswers([]);
            setPhase(result.clarifyingQuestions.length > 0 ? 'clarifying' : 'reveal');
        } else {
            // Conversion failure ladder: retry once, then accept raw answers.
            if (retryCount <= 1) {
                setRetryCount(retryCount + 1);
                setError('Conversion failed — retrying...');
                void runConversion();
            } else {
                toast.error('Conversion unavailable — using your raw answers.');
                setConvertedAnswers({});
                setPhase('reveal');
            }
        }
    };

    const submitClarifying = () => {
        setPhase('reveal');
    };

    const commit = () => {
        // Fold converted answers + clarifying answers into the draft.
        const finalAnswers: Partial<Record<CreationSlot, string>> = {
            ...draft.answers,
            ...convertedAnswers,
        };
        // Clarifying answers are appended to the relevant prose fields as
        // additional context (best-effort; the converter already ran).
        if (clarifyingAnswers.length > 0) {
            const extra = clarifyingAnswers.filter(Boolean).join(' ');
            if (extra) finalAnswers[2] = `${finalAnswers[2] ?? ''} ${extra}`.trim();
        }

        const finalDraft: CharacterCreationDraft = {
            ...draft,
            answers: finalAnswers,
            clarifyingQuestions,
            clarifyingAnswers,
        };

        commitCharacterDraft(
            { draft: finalDraft, hex: committedHex, traits: committedTraits },
            {
                setPlayerCharacter,
                setInventoryItems,
                updateContext,
                characterProfileData,
            },
        );
        toast.success(`Character "${finalDraft.name}" created!`);
        onCommit();
    };

    // ── Render ──────────────────────────────────────────────────────────────
    return (
        <div className="flex-1 overflow-y-auto flex flex-col p-6 sm:p-8">
            <div className="flex items-center justify-between mb-5">
                <h2 className="text-xl font-bold text-text-primary tracking-wide uppercase flex items-center gap-2">
                    <Wand2 size={18} className="text-terminal" /> AI-Guided Creation
                </h2>
                <button onClick={onCancel} className="text-text-dim hover:text-text-bright transition-colors" aria-label="Close">
                    <X size={18} />
                </button>
            </div>

            {error && (
                <div className="mb-4 px-3 py-2 bg-ember/10 border border-ember/40 rounded text-[11px] text-ember flex items-center gap-2">
                    <AlertTriangle size={12} /> {error}
                </div>
            )}

            {phase === 'idle' && canRun && (
                <IdleState onStart={start} loreChunkCount={eligibleCount} />
            )}

            {(phase === 'generating-questions' || phase === 'converting') && (
                <StreamPanel
                    stage={liveStage}
                    prompt={sentPrompt}
                    editablePrompt={editablePrompt}
                    setEditablePrompt={setEditablePrompt}
                    reasoning={liveReasoning}
                    content={liveContent}
                    elapsed={elapsed}
                    streamDone={streamDone}
                    onCancel={onCancel}
                    onRerun={rerunQuestions}
                    onContinue={continueToAnswering}
                />
            )}

            {phase === 'answering' && (
                <AnsweringForm
                    draft={draft}
                    setDraft={setDraft}
                    onBack={onCancel}
                    onNext={proceedToHexChoice}
                />
            )}

            {phase === 'hex-choice' && (
                <HexChoice
                    onManual={useManualHex}
                    onQuiz={startQuiz}
                    onSkip={skipHex}
                    onBack={() => setPhase('answering')}
                />
            )}

            {phase === 'quiz' && (
                <QuizForm
                    scenarios={scenarios}
                    answers={quizAnswers}
                    setAnswers={setQuizAnswers}
                    onBack={() => setPhase('hex-choice')}
                    onFinish={finishQuiz}
                />
            )}

            {phase === 'clarifying' && (
                <ClarifyingForm
                    questions={clarifyingQuestions}
                    answers={clarifyingAnswers}
                    setAnswers={setClarifyingAnswers}
                    onSkip={submitClarifying}
                    onSubmit={submitClarifying}
                />
            )}

            {phase === 'reveal' && (
                <Reveal
                    draft={draft}
                    convertedAnswers={convertedAnswers}
                    hex={committedHex}
                    traits={committedTraits}
                    onCommit={commit}
                    onBack={() => setPhase('answering')}
                />
            )}
        </div>
    );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function emptyDraft(): CharacterCreationDraft {
    return {
        name: '',
        questions: {},
        answers: {},
        visualProfile: { ...DEFAULT_VISUAL_PROFILE },
        appearance: '',
        hexMode: undefined,
        quizAnswers: {},
        clarifyingQuestions: [],
        clarifyingAnswers: [],
        step: 0,
    };
}

function phaseToStep(phase: Phase): number {
    const order: Phase[] = ['idle', 'generating-questions', 'answering', 'hex-choice', 'quiz', 'converting', 'clarifying', 'reveal'];
    return order.indexOf(phase);
}

function resumePhase(step: number): Phase {
    const order: Phase[] = ['idle', 'generating-questions', 'answering', 'hex-choice', 'quiz', 'converting', 'clarifying', 'reveal'];
    const resumed = order[Math.min(step, order.length - 1)] ?? 'idle';
    // Transient async phases have no live call behind them after a reload — resuming
    // into one shows a spinner with nothing running. Map each back to its stable
    // predecessor so the user re-triggers the call intentionally.
    if (resumed === 'generating-questions') return 'idle';
    if (resumed === 'converting') return 'answering';
    return resumed;
}

function unavailableMessage(reason: string): string {
    if (reason === 'no-lore') return 'No world lore available. Add lore chunks in the World Info tab, or use Manual Creation.';
    if (reason === 'no-endpoint') return 'No AI endpoint configured. Configure a provider in Settings, or use Manual Creation.';
    return 'AI guidance is unavailable. Please use Manual Creation.';
}

// ── Sub-views ────────────────────────────────────────────────────────────────

function UnavailableState({ reason, onCancel }: { reason: 'no-endpoint' | 'no-lore'; onCancel: () => void }) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-16 h-16 rounded-full bg-ember/10 border border-ember/30 flex items-center justify-center mb-4">
                <AlertTriangle size={28} className="text-ember/70" />
            </div>
            <p className="text-text-dim uppercase tracking-widest text-sm font-bold">AI-Guided Creation Unavailable</p>
            <p className="text-text-dim/60 text-xs mt-2 max-w-sm">
                {unavailableMessage(reason)}
            </p>
            <button
                onClick={onCancel}
                className="mt-4 px-5 py-2 bg-terminal/20 text-terminal border border-terminal/30 rounded hover:bg-terminal/30 transition-colors text-[11px] uppercase tracking-widest"
            >
                Back to Manual
            </button>
        </div>
    );
}

function IdleState({ onStart, loreChunkCount }: { onStart: () => void; loreChunkCount: number }) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-16 h-16 rounded-full bg-terminal/10 border border-terminal/30 flex items-center justify-center mb-4">
                <Wand2 size={28} className="text-terminal/70" />
            </div>
            <p className="text-text-dim uppercase tracking-widest text-sm font-bold">AI-Guided Creation</p>
            <p className="text-text-dim/60 text-xs mt-2 max-w-sm">
                Answer a short interview tailored to your world lore. The AI reskins the questions; you own the answers.
                ({loreChunkCount} lore chunks selected)
            </p>
            <button
                onClick={onStart}
                className="mt-4 px-6 py-2.5 bg-terminal/20 text-terminal border border-terminal/30 rounded hover:bg-terminal/30 transition-colors text-[11px] uppercase tracking-widest"
            >
                Begin Interview
            </button>
        </div>
    );
}

/**
 * Live transparency panel — replaces the dead spinner. Two columns:
 *   Left  — "Sent to AI": the exact prompt dispatched. Read-only while
 *           streaming; editable once finished (questions stage) so the user
 *           can tweak + re-run. This is the prompt-debugging surface.
 *   Right — live stream: the model's thinking (reasoning_content) + answer,
 *           arriving incrementally so a long think shows progress, not a hang.
 * Self-contained in the modal — no ChatArea coupling.
 */
function StreamPanel({
    stage, prompt, editablePrompt, setEditablePrompt, reasoning, content,
    elapsed, streamDone, onCancel, onRerun, onContinue,
}: {
    stage: 'lore-select' | 'questions' | 'convert';
    prompt: string;
    editablePrompt: string;
    setEditablePrompt: (v: string) => void;
    reasoning: string;
    content: string;
    elapsed: number;
    streamDone: boolean;
    onCancel: () => void;
    onRerun: () => void;
    onContinue: () => void;
}) {
    const editable = streamDone && stage === 'questions';
    return (
        <div className="flex-1 flex flex-col min-h-0 p-4 sm:p-6">
            <div className="flex items-center gap-2 mb-3 shrink-0">
                {!streamDone
                    ? <Loader2 size={16} className="text-terminal animate-spin" />
                    : <Check size={16} className="text-terminal" />}
                <span className="text-text-dim text-[11px] uppercase tracking-widest">
                    {stage === 'lore-select'
                        ? 'Reading your world lore — selecting relevant sections...'
                        : stage === 'questions'
                            ? (streamDone ? 'Questions ready — review or edit the prompt' : 'Generating questions from your world lore...')
                            : (streamDone ? 'Answers converted' : 'Converting your answers...')}
                </span>
                <span className="text-text-dim/40 text-[10px] ml-auto">{elapsed}s</span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0">
                {/* Left — Sent to AI */}
                <div className="flex flex-col min-h-0">
                    <p className="text-[9px] uppercase tracking-widest text-text-dim/60 mb-1 shrink-0">Sent to AI {editable && <span className="text-terminal/70 normal-case tracking-normal">(editable — re-run to apply)</span>}</p>
                    {editable ? (
                        <textarea
                            value={editablePrompt}
                            onChange={e => setEditablePrompt(e.target.value)}
                            className="flex-1 min-h-[180px] bg-void border border-border rounded p-2 text-[11px] text-text-primary font-mono outline-none focus:border-terminal resize-none custom-scrollbar"
                        />
                    ) : (
                        <pre className="flex-1 min-h-[180px] overflow-auto bg-void border border-border/50 rounded p-2 text-[11px] text-text-dim whitespace-pre-wrap custom-scrollbar">{prompt || '…'}</pre>
                    )}
                </div>

                {/* Right — live stream (thinking + answer) */}
                <div className="flex flex-col min-h-0 gap-3">
                    {reasoning && (
                        <div className="flex flex-col min-h-0 flex-1">
                            <p className="text-[9px] uppercase tracking-widest text-ice/70 mb-1 shrink-0">Thinking</p>
                            <pre className="flex-1 min-h-[80px] overflow-auto bg-ice/5 border border-ice/20 rounded p-2 text-[10px] text-ice/80 whitespace-pre-wrap custom-scrollbar">{reasoning}</pre>
                        </div>
                    )}
                    <div className="flex flex-col min-h-0 flex-1">
                        <p className="text-[9px] uppercase tracking-widest text-terminal/70 mb-1 shrink-0">{stage === 'lore-select' ? 'Selected sections' : stage === 'questions' ? 'Reskinned questions' : 'Converted output'}</p>
                        <pre className="flex-1 min-h-[80px] overflow-auto bg-void border border-terminal/20 rounded p-2 text-[11px] text-text-primary whitespace-pre-wrap custom-scrollbar">{content || (streamDone ? '(no output)' : '…')}</pre>
                    </div>
                </div>
            </div>

            {/* Footer actions */}
            <div className="flex items-center justify-between gap-3 mt-4 shrink-0">
                <button
                    onClick={onCancel}
                    className="px-4 py-1.5 bg-void border border-border text-text-dim hover:text-text-primary text-[10px] uppercase tracking-widest rounded transition-colors"
                >
                    {streamDone ? 'Cancel → Manual' : 'Cancel → Manual'}
                </button>
                {editable && (
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onRerun}
                            className="px-4 py-1.5 bg-void border border-border text-text-dim hover:border-terminal hover:text-terminal text-[10px] uppercase tracking-widest rounded transition-colors"
                        >
                            Re-run
                        </button>
                        <button
                            onClick={onContinue}
                            className="flex items-center gap-1.5 px-5 py-1.5 bg-terminal/20 text-terminal border border-terminal/40 hover:bg-terminal/30 text-[10px] uppercase tracking-widest rounded transition-colors"
                        >
                            Continue <ChevronRight size={12} />
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function AnsweringForm({
    draft, setDraft, onBack, onNext,
}: {
    draft: CharacterCreationDraft;
    setDraft: (d: CharacterCreationDraft) => void;
    onBack: () => void;
    onNext: () => void;
}) {
    const updateAnswer = (slot: CreationSlot, value: string) => {
        setDraft({ ...draft, answers: { ...draft.answers, [slot]: value } });
    };
    const updateVisual = (field: keyof NPCVisualProfile, value: string) => {
        setDraft({ ...draft, visualProfile: { ...(draft.visualProfile || DEFAULT_VISUAL_PROFILE), [field]: value } });
    };
    const [showMoreVisual, setShowMoreVisual] = useState(false);

    return (
        <div className="space-y-5">
            <p className="text-[10px] text-text-dim/60">Answer each question. Your draft is saved automatically.</p>

            {/* Slot 1 — Name (fixed, engine) */}
            <Field label="1. What is your character's name?">
                <input
                    type="text"
                    value={draft.name || ''}
                    onChange={e => setDraft({ ...draft, name: e.target.value })}
                    placeholder="Your character's name"
                    className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal"
                />
            </Field>

            {/* Slots 2–8 — AI-reskinned questions */}
            {ANSWER_SLOTS.map(slot => (
                <Field key={slot} label={`${slot}. ${draft.questions?.[slot] ?? ''}`}>
                    <textarea
                        value={draft.answers?.[slot] ?? ''}
                        onChange={e => updateAnswer(slot, e.target.value)}
                        rows={3}
                        placeholder="Your answer..."
                        className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal resize-y"
                    />
                </Field>
            ))}

            {/* Slot 9 — Visual profile form */}
            <Field label="9. Appearance (fill what you know — partial is fine)">
                <div className="grid grid-cols-2 gap-2 mb-2">
                    {PRIMARY_VISUAL_FIELDS.map(f => (
                        <input
                            key={f}
                            type="text"
                            value={(draft.visualProfile ?? DEFAULT_VISUAL_PROFILE)[f] || ''}
                            onChange={e => updateVisual(f, e.target.value)}
                            placeholder={f}
                            className="bg-void border border-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal"
                        />
                    ))}
                </div>
                <button
                    onClick={() => setShowMoreVisual(!showMoreVisual)}
                    className="text-[9px] text-text-dim hover:text-terminal uppercase tracking-wider"
                >
                    {showMoreVisual ? 'Hide' : 'More detail'}
                </button>
                {showMoreVisual && (
                    <div className="grid grid-cols-2 gap-2 mt-2">
                        {SECONDARY_VISUAL_FIELDS.map(f => (
                            <input
                                key={f}
                                type="text"
                                value={(draft.visualProfile ?? DEFAULT_VISUAL_PROFILE)[f] || ''}
                                onChange={e => updateVisual(f, e.target.value)}
                                placeholder={f}
                                className="bg-void border border-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal"
                            />
                        ))}
                    </div>
                )}
                <textarea
                    value={draft.appearance || ''}
                    onChange={e => setDraft({ ...draft, appearance: e.target.value })}
                    rows={2}
                    placeholder="Optional appearance prose..."
                    className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal resize-y mt-2"
                />
            </Field>

            <div className="flex justify-between pt-4 border-t border-border">
                <button onClick={onBack} className="px-4 py-2 text-xs uppercase tracking-widest text-text-dim hover:text-text-primary border border-border bg-void transition-colors">
                    <ChevronLeft size={12} className="inline" /> Cancel
                </button>
                <button
                    onClick={onNext}
                    disabled={!draft.name?.trim()}
                    className="px-6 py-2 text-xs uppercase tracking-widest text-void bg-terminal font-bold hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    Next <ChevronRight size={12} className="inline" />
                </button>
            </div>
        </div>
    );
}

function HexChoice({ onManual, onQuiz, onSkip, onBack }: {
    onManual: () => void;
    onQuiz: () => void;
    onSkip: () => void;
    onBack: () => void;
}) {
    return (
        <div className="space-y-5">
            <p className="text-sm text-text-primary">Set your character's nature yourself, or answer some questions?</p>
            <div className="flex flex-col gap-2">
                <button onClick={onQuiz} className="px-4 py-2.5 bg-terminal/20 text-terminal border border-terminal/30 rounded hover:bg-terminal/30 text-[11px] uppercase tracking-widest text-left">
                    <Wand2 size={12} className="inline mr-2" /> Answer the questionnaire
                </button>
                <button onClick={onManual} className="px-4 py-2.5 bg-void text-text-dim border border-border rounded hover:border-terminal hover:text-terminal text-[11px] uppercase tracking-widest text-left">
                    Set the hex myself on the sheet
                </button>
                <button onClick={onSkip} className="px-4 py-2.5 bg-void text-text-dim border border-border rounded hover:border-text-primary text-[11px] uppercase tracking-widest text-left">
                    Skip — hex stays all-zero (valid)
                </button>
            </div>
            <button onClick={onBack} className="px-4 py-2 text-xs uppercase tracking-widest text-text-dim hover:text-text-primary border border-border bg-void transition-colors">
                <ChevronLeft size={12} className="inline" /> Back
            </button>
        </div>
    );
}

function QuizForm({ scenarios, answers, setAnswers, onBack, onFinish }: {
    scenarios: QuizScenario[];
    answers: Record<number, number>;
    setAnswers: (a: Record<number, number>) => void;
    onBack: () => void;
    onFinish: () => void;
}) {
    const allAnswered = scenarios.every(s => answers[s.id] !== undefined);
    return (
        <div className="space-y-5">
            <p className="text-[10px] text-text-dim/60">Pick the response that fits your character. There are no right answers.</p>
            {scenarios.map(s => (
                <div key={s.id} className="bg-void border border-border rounded p-3">
                    <p className="text-[12px] text-text-primary mb-2">{s.prompt}</p>
                    <div className="flex flex-col gap-1.5">
                        {s.options.map((opt, i) => (
                            <button
                                key={i}
                                onClick={() => setAnswers({ ...answers, [s.id]: i })}
                                className={`text-left px-3 py-1.5 rounded text-[11px] border transition-colors ${
                                    answers[s.id] === i
                                        ? 'bg-terminal/10 border-terminal text-terminal'
                                        : 'bg-surface border-border/50 text-text-dim hover:border-border hover:text-text-primary'
                                }`}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                </div>
            ))}
            <div className="flex justify-between pt-4 border-t border-border">
                <button onClick={onBack} className="px-4 py-2 text-xs uppercase tracking-widest text-text-dim hover:text-text-primary border border-border bg-void">
                    <ChevronLeft size={12} className="inline" /> Back
                </button>
                <button
                    onClick={onFinish}
                    disabled={!allAnswered}
                    className="px-6 py-2 text-xs uppercase tracking-widest text-void bg-terminal font-bold disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    Finish <Check size={12} className="inline" />
                </button>
            </div>
        </div>
    );
}

function ClarifyingForm({ questions, answers, setAnswers, onSkip, onSubmit }: {
    questions: string[];
    answers: string[];
    setAnswers: (a: string[]) => void;
    onSkip: () => void;
    onSubmit: () => void;
}) {
    return (
        <div className="space-y-5">
            <p className="text-sm text-text-primary">A few clarifying questions (you can skip these):</p>
            {questions.map((q, i) => (
                <Field key={i} label={q}>
                    <textarea
                        value={answers[i] || ''}
                        onChange={e => {
                            const next = [...answers];
                            next[i] = e.target.value;
                            setAnswers(next);
                        }}
                        rows={2}
                        placeholder="Your answer (optional)..."
                        className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal resize-y"
                    />
                </Field>
            ))}
            <div className="flex justify-between pt-4 border-t border-border">
                <button onClick={onSkip} className="px-4 py-2 text-xs uppercase tracking-widest text-text-dim hover:text-text-primary border border-border bg-void">
                    Skip
                </button>
                <button onClick={onSubmit} className="px-6 py-2 text-xs uppercase tracking-widest text-void bg-terminal font-bold">
                    Continue <ChevronRight size={12} className="inline" />
                </button>
            </div>
        </div>
    );
}

function Reveal({ draft, convertedAnswers, hex, traits, onCommit, onBack }: {
    draft: CharacterCreationDraft;
    convertedAnswers: Partial<Record<CreationSlot, string>>;
    hex?: import('../../types').PersonalityHex;
    traits?: string[];
    onCommit: () => void;
    onBack: () => void;
}) {
    const topAxes = useMemo(() => {
        if (!hex) return [];
        return (Object.entries(hex) as [import('../../types').HexAxis, number][])
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
            .slice(0, 2);
    }, [hex]);

    const name = draft.name || 'Unnamed';
    const finalAnswers = { ...draft.answers, ...convertedAnswers };

    return (
        <div className="space-y-5">
            <div className="text-center py-4">
                <p className="text-text-dim uppercase tracking-widest text-[10px]">Your Character</p>
                <h3 className="text-2xl font-bold text-terminal mt-1">{name}</h3>
                {topAxes.length > 0 && (
                    <p className="text-text-dim/70 text-xs mt-2">
                        {topAxes.map(([axis, v]) => `${axis}: ${hexBand(axis, v)}`).join(' · ')}
                    </p>
                )}
                {traits && traits.length > 0 && (
                    <div className="flex flex-wrap justify-center gap-1.5 mt-3">
                        {traits.map(t => (
                            <span key={t} className="px-2 py-0.5 bg-surface border border-border rounded text-[10px] text-text-primary">{t}</span>
                        ))}
                    </div>
                )}
            </div>

            <div className="bg-void border border-border rounded p-4 space-y-2">
                <p className="text-[9px] uppercase tracking-widest text-text-dim/70 border-b border-border/30 pb-1">Summary</p>
                {ANSWER_SLOTS.map(slot => (
                    <div key={slot} className="text-[11px]">
                        <span className="text-text-dim/60 uppercase text-[9px] tracking-wider">{slot}.</span>
                        <span className="text-text-primary ml-2">{finalAnswers[slot] || '(unanswered)'}</span>
                    </div>
                ))}
            </div>

            <div className="flex justify-between pt-4 border-t border-border">
                <button onClick={onBack} className="px-4 py-2 text-xs uppercase tracking-widest text-text-dim hover:text-text-primary border border-border bg-void">
                    <ChevronLeft size={12} className="inline" /> Back
                </button>
                <button onClick={onCommit} className="px-6 py-2 text-xs uppercase tracking-widest text-void bg-terminal font-bold">
                    <Check size={12} className="inline" /> Create Character
                </button>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">{label}</label>
            {children}
        </div>
    );
}

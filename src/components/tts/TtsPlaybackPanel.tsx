import { Loader2, Volume2, Play, Pause, RotateCw, Trash2 } from 'lucide-react';
import { chunkSentencesForTTS, splitWords } from '../../services/tts/proseStripper';

/**
 * Karaoke TTS playback panel — sticky status/controls header over a
 * scrollable highlight-synced transcript. Extracted from MessageBubble;
 * purely presentational, all state lives in useTtsPlayback.
 */
export function TtsPlaybackPanel({
    prose,
    ttsLoading,
    ttsPaused,
    ttsPlaying,
    ttsFinished,
    activeSentenceIdx,
    activeWordIdx,
    playbackRate,
    totalChunks,
    generatedChunks,
    onPauseResume,
    onSpeedChange,
    onSpeak,
    onWipe,
    onSentenceClick,
}: {
    prose: string;
    ttsLoading: boolean;
    ttsPaused: boolean;
    ttsPlaying: boolean;
    ttsFinished: boolean;
    activeSentenceIdx: number;
    activeWordIdx: number;
    playbackRate: number;
    totalChunks: number;
    generatedChunks: number;
    onPauseResume: () => void;
    onSpeedChange: (delta: number) => void;
    onSpeak: () => void;
    onWipe: () => void;
    onSentenceClick: (sentenceIndex: number) => void;
}) {
    return (
        <div className="mb-3 rounded border border-terminal/30 bg-terminal/5 max-h-[160px] overflow-y-auto relative">
            {/* Sticky header — status + controls, always visible while scrolling */}
            <div className="sticky top-0 z-10 bg-void-darker/95 backdrop-blur-sm border-b border-terminal/20 px-2 py-1 flex items-center gap-1 justify-between flex-wrap">
                <span className="flex items-center gap-1.5 text-[9px] text-terminal/60 uppercase tracking-widest shrink-0">
                    {ttsLoading ? <Loader2 size={10} className="animate-spin" /> : ttsFinished ? <RotateCw size={10} /> : ttsPaused ? <Pause size={10} /> : <Volume2 size={10} />}
                    {ttsLoading ? 'Synthesizing' : ttsFinished ? 'Finished' : ttsPaused ? 'Paused' : 'Reading'}
                </span>
                {totalChunks > 0 && (
                    <span className="text-[9px] text-text-dim/60 normal-case tracking-normal shrink-0 mr-1 flex items-center gap-1.5">
                        <span title="Playback position">
                            ▶ {ttsFinished ? totalChunks : (activeSentenceIdx >= 0 ? activeSentenceIdx + 1 : 0)}/{totalChunks}
                        </span>
                        {generatedChunks < totalChunks && (
                            <span title="Kokoro generation progress" className="text-terminal/70 flex items-center gap-0.5">
                                <Loader2 size={8} className="animate-spin" /> gen {generatedChunks}/{totalChunks}
                            </span>
                        )}
                        {generatedChunks >= totalChunks && !ttsFinished && (
                            <span className="text-terminal/50">all buffered</span>
                        )}
                    </span>
                )}
                {/* Controls inline in the header */}
                <div className="flex items-center gap-1 ml-auto">
                    {ttsPlaying && (
                        <button title={ttsPaused ? 'Resume' : 'Pause'} onClick={onPauseResume} className="text-text-dim hover:text-terminal px-1 py-0.5 rounded flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider">
                            {ttsPaused ? <><Play size={10} /> Resume</> : <><Pause size={10} /> Pause</>}
                        </button>
                    )}
                    <span className="text-[8px] text-text-dim/50 normal-case tracking-normal hidden lg:inline">click a sentence to jump</span>
                    <div className="w-px h-4 bg-border/40 mx-0.5" />
                    <button title="Slower" onClick={() => onSpeedChange(-0.25)} className="text-text-dim hover:text-terminal px-1 py-0.5 rounded text-[9px] font-bold">
                        ½×
                    </button>
                    <span className="text-[9px] text-text-dim font-mono w-9 text-center">{playbackRate.toFixed(2)}×</span>
                    <button title="Faster" onClick={() => onSpeedChange(0.25)} className="text-text-dim hover:text-terminal px-1 py-0.5 rounded text-[9px] font-bold">
                        2×
                    </button>
                    {ttsFinished && (
                        <>
                            <div className="w-px h-4 bg-border/40 mx-0.5" />
                            <button title="Replay" onClick={onSpeak} className="text-terminal hover:text-terminal px-1 py-0.5 rounded flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider">
                                <Play size={10} /> Replay
                            </button>
                        </>
                    )}
                    {/* Trash — only thing that wipes the cache */}
                    <div className="w-px h-4 bg-border/40 mx-0.5" />
                    <button title="Delete generated audio" onClick={onWipe} className="text-text-dim hover:text-red-400 px-1 py-0.5 rounded flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider">
                        <Trash2 size={10} />
                    </button>
                </div>
            </div>
            {/* Karaoke text scrolls under the frozen header */}
            <div className="px-2 py-1.5">
                <KaraokeText
                    prose={prose}
                    sentenceIdx={activeSentenceIdx}
                    wordIdx={activeWordIdx}
                    finished={ttsFinished}
                    generatedChunks={generatedChunks}
                    onSentenceClick={onSentenceClick}
                />
            </div>
        </div>
    );
}

/**
 * Karaoke-style prose renderer for TTS highlight sync.
 * Each sentence is clickable (jumps playback to that chunk). Generated chunks
 * are normal text; ungenerated chunks are dimmed + italicized. The active word
 * in the active sentence is highlighted. Past sentences are dimmed.
 */
export function KaraokeText({
    prose,
    sentenceIdx,
    wordIdx,
    finished,
    generatedChunks = 0,
    onSentenceClick,
}: {
    prose: string;
    sentenceIdx: number;
    wordIdx: number;
    finished?: boolean;
    generatedChunks?: number;
    onSentenceClick?: (sentenceIndex: number) => void;
}) {
    const sentences = chunkSentencesForTTS(prose);
    const isInteractive = !!onSentenceClick && (sentenceIdx >= 0 || finished);
    return (
        <div className={`text-[11px] leading-relaxed ${finished ? 'text-text-dim/50' : 'text-text-primary'}`}>
            {sentences.map((sent, si) => {
                const words = splitWords(sent);
                const isPast = sentenceIdx >= 0 && si < sentenceIdx;
                const isActive = si === sentenceIdx && !finished;
                const isGenerated = si < generatedChunks || finished;
                const canClick = isInteractive && isGenerated;
                return (
                    <span
                        key={si}
                        onClick={canClick ? () => onSentenceClick!(si) : undefined}
                        className={[
                            isPast || finished ? 'text-text-dim/40' : '',
                            !isGenerated ? 'text-text-dim/30 italic' : '',
                            canClick ? 'cursor-pointer hover:bg-terminal/20 hover:text-terminal rounded px-0.5 transition-colors' : '',
                        ].join(' ')}
                    >
                        {words.map((w, wi) => (
                            <span
                                key={wi}
                                className={
                                    isActive && wi === wordIdx
                                        ? 'bg-terminal/30 text-terminal font-bold rounded px-[1px]'
                                        : isActive
                                            ? 'text-text-primary'
                                            : ''
                                }
                            >
                                {w}{' '}
                            </span>
                        ))}
                        {' '}
                    </span>
                );
            })}
        </div>
    );
}

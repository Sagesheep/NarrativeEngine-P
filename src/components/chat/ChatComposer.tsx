import { useRef } from 'react';
import type { RefObject } from 'react';
import { Send, Square, ImagePlus } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { ChatAttachmentChip } from './ChatAttachmentChip';
import type { ChatAttachment } from '../hooks/useChatAttachment';
import { GalleryPicker, GalleryArmedChips, GallerySuggestions } from './GalleryComposerBar';
import type { useGalleryMention } from '../hooks/useGalleryMention';

/**
 * Bottom composer row: active-preset selector, deep-search armed chip,
 * auto-growing input textarea, and the send/stop toggle button.
 */
export function ChatComposer({
    input,
    inputRef,
    isStreaming,
    oocBusy,
    onInputChange,
    onKeyDown,
    onSend,
    onStop,
    attachment,
    attachmentBusy,
    onAttachFile,
    onAttachFromDataTransfer,
    onCaptionChange,
    onRemoveAttachment,
    gallery,
}: {
    input: string;
    inputRef: RefObject<HTMLTextAreaElement | null>;
    isStreaming: boolean;
    oocBusy: boolean;
    onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onSend: () => void;
    onStop: () => void;
    attachment?: ChatAttachment | null;
    attachmentBusy?: boolean;
    onAttachFile?: (file: File) => void;
    onAttachFromDataTransfer?: (data: DataTransfer | null) => boolean;
    onCaptionChange?: (caption: string) => void;
    onRemoveAttachment?: () => void;
    gallery?: ReturnType<typeof useGalleryMention>;
}) {
    const settings = useAppStore(s => s.settings);
    const deepArmed = useAppStore(s => s.deepArmed);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Paste an image straight into the box. Only swallows the event when an
    // image was actually found, so pasting text still behaves normally.
    const handlePaste = (e: React.ClipboardEvent) => {
        if (!onAttachFromDataTransfer) return;
        if (onAttachFromDataTransfer(e.clipboardData)) e.preventDefault();
    };

    const handleDrop = (e: React.DragEvent) => {
        if (!onAttachFromDataTransfer) return;
        if (onAttachFromDataTransfer(e.dataTransfer)) e.preventDefault();
    };

    return (
        <div
            className="px-2 sm:px-4 pb-3 sm:pb-4 pt-3 sm:pt-4"
            onDrop={handleDrop}
            onDragOver={e => { if (onAttachFromDataTransfer) e.preventDefault(); }}
        >
            {gallery && (
                <>
                    <GalleryPicker
                        matches={gallery.pickerOpen ? gallery.matches : []}
                        activeIndex={gallery.activeIndex}
                        onHover={gallery.setActiveIndex}
                        onPick={gallery.pick}
                    />
                    <GalleryArmedChips armed={gallery.armed} onRemove={gallery.unarm} />
                    {!gallery.pickerOpen && (
                        <GallerySuggestions
                            suggestions={gallery.suggestions}
                            onAdd={gallery.arm}
                            onDismiss={gallery.dismissSuggestion}
                        />
                    )}
                </>
            )}
            {attachment && onCaptionChange && onRemoveAttachment && (
                <ChatAttachmentChip
                    attachment={attachment}
                    onCaptionChange={onCaptionChange}
                    onRemove={onRemoveAttachment}
                />
            )}
            <div className="flex gap-1 border border-border bg-void focus-within:border-terminal transition-colors items-end p-1 rounded-sm">
                <div className="relative shrink-0 mb-[4px] ml-1">
                    <select
                        value={settings.activePresetId}
                        onChange={(e) => useAppStore.getState().setActivePreset(e.target.value)}
                        className="h-[32px] bg-surface border border-border text-text-dim hover:text-terminal hover:border-terminal/50 pl-3 pr-7 text-[10px] uppercase tracking-widest focus:outline-none focus:border-terminal max-w-[120px] sm:max-w-[150px] truncate cursor-pointer appearance-none rounded transition-colors font-bold"
                        title="Active AI Preset"
                    >
                        {settings.presets.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </select>
                    <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-dim pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                </div>
                {deepArmed && (
                    <div className="shrink-0 mb-[4px] px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-widest bg-amber-500/15 text-amber-400 border border-amber-500/40 rounded animate-pulse">
                        Deep
                    </div>
                )}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) onAttachFile?.(file);
                        e.target.value = '';
                    }}
                />
                {onAttachFile && (
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isStreaming || attachmentBusy || !!attachment}
                        title={attachment ? 'One image at a time — remove the current one first' : 'Attach an image (or just paste one)'}
                        className="h-[32px] w-[32px] mb-[4px] rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center shrink-0 text-text-dim hover:text-terminal hover:bg-terminal/10"
                    >
                        <ImagePlus size={15} />
                    </button>
                )}
                <textarea
                    ref={inputRef}
                    value={input}
                    onChange={e => { onInputChange(e); gallery?.syncFromTextarea(); }}
                    onKeyDown={e => {
                        // The picker claims Enter/Tab/arrows while it is open, so
                        // Enter selects a match instead of sending the message.
                        if (gallery?.handleKeyDown(e)) return;
                        onKeyDown(e);
                    }}
                    onKeyUp={() => gallery?.syncFromTextarea()}
                    onClick={() => gallery?.syncFromTextarea()}
                    onPaste={handlePaste}
                    placeholder="What do you do?"
                    className="flex-1 bg-transparent px-2 py-2.5 text-sm text-text-primary placeholder:text-text-dim/40 font-mono resize-none border-none outline-none min-h-[40px] leading-5"
                />
                <button
                    onClick={isStreaming ? onStop : onSend}
                    disabled={!isStreaming && ((!input.trim() && !attachment?.caption.trim()) || oocBusy || !!attachmentBusy)}
                    className={`h-[32px] w-[44px] mb-[4px] rounded transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center shrink-0 ${isStreaming ? 'text-amber-500 hover:bg-amber-500/10' : 'text-terminal hover:bg-terminal/10'}`}
                >
                    {isStreaming ? <Square size={16} fill="currentColor" /> : <Send size={16} />}
                </button>
            </div>
        </div>
    );
}

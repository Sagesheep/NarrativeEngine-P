import { Loader2, Image as ImageIcon, Trash2, Upload, ScanEye } from '../icons/narrativeIcons';
import { useRef } from 'react';
import { DEFAULT_PORTRAIT_ART_STYLE, PORTRAIT_ART_STYLE_OPTIONS } from '../../data/portraitStyles';
import { NarratorLimitHint } from './NarratorLimitHint';
import { useVisionDescribe } from '../hooks/useVisionDescribe';

type Props = {
    portrait?: string;
    name: string;
    isEditing: boolean;
    isGeneratingImage: boolean;
    onGeneratePortrait: () => void;
    onUploadPortrait: (file: File) => void;
    onRemovePortrait: () => void;
    appearance: string;
    onAppearanceChange: (value: string) => void;
    artStyle?: string;
    onArtStyleChange: (value: string) => void;
};

export function NPCPortraitSection({
    portrait, name, isEditing, isGeneratingImage,
    onGeneratePortrait, onUploadPortrait, onRemovePortrait, appearance, onAppearanceChange, artStyle, onArtStyleChange,
}: Props) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { isDescribing, visionConfigured, describe } = useVisionDescribe();

    // Vision v1 — read the portrait back into the appearance the payload already
    // carries. Writes to FORM state only; the user still has to press Save.
    const handleReadImage = async () => {
        if (!portrait) return;
        const result = await describe(portrait, name);
        if (!result) return;
        onAppearanceChange(result.appearance);
        if (result.artStyle) onArtStyleChange(result.artStyle);
    };

    const readImageTitle = !portrait
        ? 'Add a portrait first'
        : !visionConfigured
            ? 'No Vision AI configured (Settings → Presets → Vision AI)'
            : !isEditing
                ? 'Click Edit first — the description lands in the appearance box for you to review'
                : 'Read this image with the Vision AI and draft the appearance below';

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) onUploadPortrait(file);
        // Reset so the same file can be re-selected later.
        e.target.value = '';
    };
    return (
        <div className="bg-void-lighter p-4 rounded border border-border shadow-inner">
            {portrait ? (
                <div className="relative group mb-4 rounded overflow-hidden border border-border">
                    <img
                        src={portrait}
                        alt={name || 'NPC Portrait'}
                        className="w-full aspect-[3/4] object-cover object-top"
                    />
                    <button
                        type="button"
                        onClick={onGeneratePortrait}
                        disabled={isGeneratingImage || !name}
                        className="absolute bottom-2 right-2 flex items-center gap-1.5 px-2.5 py-1 bg-void/80 border border-border hover:border-terminal text-terminal text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50 opacity-0 group-hover:opacity-100"
                    >
                        {isGeneratingImage ? <Loader2 size={11} className="animate-spin" /> : <ImageIcon size={11} />}
                        Regenerate
                    </button>
                    <button
                        type="button"
                        onClick={onRemovePortrait}
                        disabled={isGeneratingImage}
                        title="Remove this portrait from the record"
                        className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2.5 py-1 bg-void/80 border border-danger/50 hover:border-danger text-danger text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50 opacity-0 group-hover:opacity-100"
                    >
                        <Trash2 size={11} />
                        Remove
                    </button>
                </div>
            ) : null}

            <div className="flex items-center justify-between mb-4 border-b border-border/50 pb-2">
                <div className="text-terminal font-bold uppercase tracking-widest text-xs">
                    Look &amp; Portrait
                </div>
                <div className="flex items-center gap-2">

                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handleFileChange}
                        className="hidden"
                    />
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isGeneratingImage || !name}
                        title="Upload a portrait image from your computer"
                        className="flex items-center gap-1 px-2 py-1 border border-border hover:border-terminal text-terminal text-[9px] uppercase tracking-wider rounded transition-colors disabled:opacity-50"
                    >
                        <Upload size={10} />
                        Upload
                    </button>
                    <button
                        type="button"
                        onClick={handleReadImage}
                        disabled={isDescribing || isGeneratingImage || !portrait || !isEditing || !visionConfigured}
                        title={readImageTitle}
                        className="flex items-center gap-1 px-2 py-1 border border-border hover:border-terminal text-terminal text-[9px] uppercase tracking-wider rounded transition-colors disabled:opacity-50"
                    >
                        {isDescribing ? <Loader2 size={10} className="animate-spin" /> : <ScanEye size={10} />}
                        {isDescribing ? 'Reading…' : 'Read Image'}
                    </button>
                    <button
                        type="button"
                        onClick={onGeneratePortrait}
                        disabled={isGeneratingImage || !name}
                        title="Generate portrait from the appearance"
                        className="flex items-center gap-1 px-2 py-1 border border-border hover:border-terminal text-terminal text-[9px] uppercase tracking-wider rounded transition-colors disabled:opacity-50"
                    >
                        {isGeneratingImage ? <Loader2 size={10} className="animate-spin" /> : <ImageIcon size={10} />}
                        {isGeneratingImage ? 'Generating\u2026' : portrait ? 'Regenerate Portrait' : 'Generate Portrait'}
                    </button>
                </div>
            </div>

            <div>
                <label className="block text-text-dim text-[9px] uppercase tracking-wider mb-1">Appearance</label>
                <textarea
                    value={appearance || ''}
                    onChange={e => onAppearanceChange(e.target.value)}
                    disabled={!isEditing}
                    rows={5}
                    placeholder="Lead with what identifies them at a glance — species, age, build — then hair, eyes, clothing, gear, marks."
                    className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-y focus:outline-none focus:border-terminal"
                />
                <NarratorLimitHint field="appearance" length={(appearance || '').length} note="the portrait uses all of it" />
            </div>

            <div className="mt-3">
                <label className="block text-text-dim text-[9px] uppercase tracking-wider mb-1">Art Style</label>
                <select
                    value={artStyle || DEFAULT_PORTRAIT_ART_STYLE}
                    onChange={e => onArtStyleChange(e.target.value)}
                    disabled={!isEditing}
                    className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal outline-none"
                >
                    {PORTRAIT_ART_STYLE_OPTIONS.map(style => (
                        <option key={style.value} value={style.value}>{style.label}</option>
                    ))}
                </select>
            </div>
        </div>
    );
}

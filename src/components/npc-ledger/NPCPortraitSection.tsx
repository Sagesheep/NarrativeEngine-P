import { Loader2, Image as ImageIcon, Trash2, Upload } from 'lucide-react';
import type { NPCVisualProfile } from '../../types';
import { useRef } from 'react';
import { DEFAULT_PORTRAIT_ART_STYLE, PORTRAIT_ART_STYLE_OPTIONS } from '../../data/portraitStyles';

type Props = {
    portrait?: string;
    name: string;
    visualProfile: NPCVisualProfile;
    isEditing: boolean;
    isGeneratingImage: boolean;
    onGeneratePortrait: () => void;
    onUploadPortrait: (file: File) => void;
    onRemovePortrait: () => void;
    onVisualProfileChange: (field: keyof NPCVisualProfile, value: string) => void;
    appearance: string;
    onAppearanceChange: (value: string) => void;
};

export function NPCPortraitSection({
    portrait, name, visualProfile, isEditing, isGeneratingImage,
    onGeneratePortrait, onUploadPortrait, onRemovePortrait, onVisualProfileChange, appearance, onAppearanceChange,
}: Props) {
    const fileInputRef = useRef<HTMLInputElement>(null);

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
                    Visual Profile (AI Ready)
                </div>
                <div className="flex items-center gap-2">
                    <div className="text-[9px] uppercase tracking-wider text-text-dim hidden sm:block">Portrait Generation Data</div>
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
                        onClick={onGeneratePortrait}
                        disabled={isGeneratingImage || !name}
                        title="Generate portrait from visual profile"
                        className="flex items-center gap-1 px-2 py-1 border border-border hover:border-terminal text-terminal text-[9px] uppercase tracking-wider rounded transition-colors disabled:opacity-50"
                    >
                        {isGeneratingImage ? <Loader2 size={10} className="animate-spin" /> : <ImageIcon size={10} />}
                        {isGeneratingImage ? 'Generating\u2026' : portrait ? 'Regenerate Portrait' : 'Generate Portrait'}
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
                {[
                    { k: 'race', l: 'Race / Species' },
                    { k: 'gender', l: 'Gender' },
                    { k: 'ageRange', l: 'Age Range' },
                    { k: 'build', l: 'Build / Body Type' },
                    { k: 'symmetry', l: 'Attract / Symmetry' },
                    { k: 'skinTone', l: 'Skin Tone' },
                    { k: 'hairStyle', l: 'Hair Style & Color' },
                    { k: 'eyeColor', l: 'Eye Color' },
                    { k: 'gait', l: 'Gait / Posture' },
                    { k: 'clothing', l: 'Clothing Style' },
                    { k: 'distinctMarks', l: 'Distinct Marks' },
                ].map(({ k, l }) => (
                    <div key={k} className={k === 'clothing' || k === 'distinctMarks' ? 'col-span-2' : ''}>
                        <label className="block text-text-dim text-[9px] uppercase tracking-wider mb-1">{l}</label>
                        <input
                            type="text"
                            value={visualProfile?.[k as keyof NPCVisualProfile] || ''}
                            onChange={e => onVisualProfileChange(k as keyof NPCVisualProfile, e.target.value)}
                            disabled={!isEditing}
                            className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal"
                        />
                    </div>
                ))}
            </div>

            <div className="mt-3">
                <label className="block text-text-dim text-[9px] uppercase tracking-wider mb-1">Art Style</label>
                <select
                    value={visualProfile?.artStyle || DEFAULT_PORTRAIT_ART_STYLE}
                    onChange={e => onVisualProfileChange('artStyle', e.target.value)}
                    disabled={!isEditing}
                    className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal outline-none"
                >
                    {PORTRAIT_ART_STYLE_OPTIONS.map(style => (
                        <option key={style.value} value={style.value}>{style.label}</option>
                    ))}
                </select>
            </div>

            <div className="mt-4 pt-4 border-t border-border/50">
                <label className="block text-text-dim text-[9px] uppercase tracking-wider mb-1">Legacy Appearance Notes (used only if visual fields are empty)</label>
                <textarea
                    value={appearance || ''}
                    onChange={e => onAppearanceChange(e.target.value)}
                    disabled={!isEditing}
                    rows={2}
                    className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none focus:outline-none focus:border-terminal"
                />
            </div>
        </div>
    );
}

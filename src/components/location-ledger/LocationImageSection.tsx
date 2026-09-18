import { useEffect, useRef, useState } from 'react';
import { ImageIcon, Loader2, Trash2, Upload } from 'lucide-react';
import type { LocationEntry } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { generateNPCPortrait } from '../../services/npc-generation/portrait';
import { downloadImageToLocal, uploadImageToLocal } from '../../services/infrastructure/assetService';
import { toast } from '../Toast';

type Props = {
    location: Partial<LocationEntry>;
    isEditing: boolean;
    onChange: (image: string | undefined) => void;
    onBusyChange: (busy: boolean) => void;
};

export function LocationImageSection({ location, isEditing, onChange, onBusyChange }: Props) {
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const active = useRef(false);
    const inFlight = useRef(false);
    useEffect(() => {
        active.current = true;
        return () => { active.current = false; };
    }, []);

    const run = async (file?: File) => {
        if (!isEditing || inFlight.current) return;
        const state = useAppStore.getState();
        const campaignId = state.activeCampaignId;
        const config = state.getActiveImageEndpoint();
        if (!file && !config?.endpoint) {
            toast.warning('Configure an Image AI endpoint in Settings to generate location pictures.');
            return;
        }
        inFlight.current = true;
        setBusy(true);
        onBusyChange(true);
        try {
            const name = location.name?.trim() || 'Location';
            let path: string;
            if (file) {
                path = await uploadImageToLocal(file, name);
            } else {
                const prompt = [
                    'Create a detailed landscape illustration of a story location. Wide establishing view, environment as the subject.',
                    'Match the setting described below. No character portrait, captions, labels, text, logos, or watermarks.',
                    'Location: ' + name,
                    location.broadLocation && 'Region: ' + location.broadLocation,
                    location.description && 'Description: ' + location.description,
                    location.features?.length && 'Features: ' + location.features.join(', '),
                    location.status && 'Current condition: ' + location.status,
                ].filter(Boolean).join('\n');
                const url = await generateNPCPortrait(config!, prompt, 'landscape');
                path = await downloadImageToLocal(url, name);
            }
            // The editor is keyed by campaign, record, and edit mode. Cancel,
            // navigation, or closing it unmounts us and discards late results.
            if (active.current && useAppStore.getState().activeCampaignId === campaignId) onChange(path);
        } catch (error) {
            if (active.current && useAppStore.getState().activeCampaignId === campaignId) {
                toast.error('Location picture failed: ' + (error instanceof Error ? error.message : String(error)));
            }
        } finally {
            inFlight.current = false;
            if (active.current) {
                setBusy(false);
                onBusyChange(false);
            }
        }
    };

    const buttonClass = 'flex items-center gap-1.5 px-3 py-1.5 border border-border rounded text-xs text-terminal hover:border-terminal disabled:opacity-40';
    return (
        <section aria-label="Location picture" className="border border-border rounded bg-void overflow-hidden">
            {location.image ? (
                <img src={location.image} alt={(location.name || 'Location') + ' picture'} className="w-full aspect-video object-contain bg-void-lighter" />
            ) : (
                <div className="flex items-center justify-center gap-2 h-28 text-text-dim text-xs"><ImageIcon size={22} /> No location picture</div>
            )}
            {isEditing && (
                <div className="p-3 space-y-2">
                    <div className="flex flex-wrap gap-2">
                        <input ref={input} type="file" accept="image/*" aria-label="Upload location picture" className="hidden" onChange={event => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (file) void run(file);
                        }} />
                        <button type="button" disabled={busy} className={buttonClass} onClick={() => input.current?.click()}><Upload size={13} /> Upload Picture</button>
                        <button type="button" disabled={busy || !location.name?.trim()} className={buttonClass} onClick={() => void run()}>
                            {busy ? <Loader2 size={13} className="animate-spin" /> : <ImageIcon size={13} />}
                            {busy ? 'Working…' : location.image ? 'Regenerate Picture' : 'Generate Picture'}
                        </button>
                        {location.image && <button type="button" disabled={busy} className={buttonClass} onClick={() => onChange(undefined)}><Trash2 size={13} /> Remove Picture</button>}
                    </div>
                    <p className="text-[10px] text-text-dim">Generation uses the name, region, description, features, and current condition. Save to keep picture changes.</p>
                </div>
            )}
        </section>
    );
}

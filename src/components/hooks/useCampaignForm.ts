import { useRef, useState } from 'react';
import { saveCampaign, getNPCLedger, saveNPCLedger, getLoreChunks, saveLoreChunks } from '../../store/campaignStore';
import { initializeCampaignState } from '../../services/campaignInit';
import { uid } from '../../utils/uid';
import { readWorldFile, type WorldImport } from '../../services/lore/worldCard';
import type { CampaignRosterEntry } from '../../services/import/campaignRoster';
import { uploadImageToLocal } from '../../services/infrastructure/assetService';
import { hydrateCampaign } from '../../store/campaignHydrator';
import { toast } from '../Toast';
import type { Campaign, NPCEntry } from '../../types';

export function useCampaignForm(params: {
    editingCampaign: Campaign | null;
    setEditingCampaign: (c: Campaign | null) => void;
    onDone: () => void;
}) {
    const { editingCampaign, setEditingCampaign, onDone } = params;
    const [name, setName] = useState('');
    const [coverFile, setCoverFile] = useState<File | null>(null);
    const [coverPreview, setCoverPreview] = useState('');
    const [loreFile, setLoreFile] = useState<File | null>(null);
    const [loreName, setLoreName] = useState('');
    const [rulesFile, setRulesFile] = useState<File | null>(null);
    const [rulesName, setRulesName] = useState('');
    const [lootFile, setLootFile] = useState<File | null>(null);
    const [lootName, setLootName] = useState('');
    const [roster, setRoster] = useState<CampaignRosterEntry[]>([]);
    const [preparedWorld, setPreparedWorld] = useState<WorldImport>();
    const [saving, setSaving] = useState(false);
    const saveLock = useRef(false);
    const pendingId = useRef<string | null>(null);

    const resetForm = () => {
        setName(''); setCoverFile(null); setCoverPreview('');
        setLoreFile(null); setLoreName('');
        setRulesFile(null); setRulesName('');
        setLootFile(null); setLootName('');
        setRoster([]); setPreparedWorld(undefined); pendingId.current = null;
        setEditingCampaign(null);
    };
    const openCreate = () => { resetForm(); };
    const openEdit = (campaign: Campaign) => {
        resetForm(); setEditingCampaign(campaign);
        setName(campaign.name); setCoverPreview(campaign.coverImage || '');
    };
    const handleCoverChange = (file: File) => {
        setCoverFile(file);
        const reader = new FileReader();
        reader.onload = e => setCoverPreview(e.target?.result as string);
        reader.readAsDataURL(file);
    };
    const handleSave = async () => {
        if (!name.trim() || saveLock.current) return;
        const names = roster.map(e => e.npc.name.trim().toLowerCase());
        if (names.some(n => !n) || new Set(names).size !== names.length) {
            toast.error('Give every NPC a unique, non-empty name.'); return;
        }
        saveLock.current = true; setSaving(true);
        try {
            const world = preparedWorld ?? (loreFile && /\.(png|json)$/i.test(loreFile.name) ? await readWorldFile(loreFile) : undefined);
            const isEdit = !!editingCampaign;
            const campaign: Campaign = isEdit
                ? { ...editingCampaign!, name: name.trim(), lastPlayedAt: Date.now() }
                : { id: pendingId.current ?? (pendingId.current = uid()), name: name.trim(), coverImage: '', createdAt: Date.now(), lastPlayedAt: Date.now() };
            if (coverFile || isEdit) campaign.coverImage = coverPreview;
            await saveCampaign(campaign);
            await initializeCampaignState({ campaignId: campaign.id, loreFile, rulesFile, lootFile, preparedWorld: world });
            if (roster.length) {
                const npcs: NPCEntry[] = [];
                for (const entry of roster) {
                    const npc = { ...entry.npc, name: entry.npc.name.trim() };
                    if (entry.portraitFile) {
                        try { npc.portrait = await uploadImageToLocal(entry.portraitFile, npc.name); }
                        catch { toast.warning(`Imported ${npc.name} without a portrait; you can upload it again from the roster.`); }
                    }
                    npcs.push(npc);
                }
                const existing = await getNPCLedger(campaign.id);
                // Staged cards take precedence over NPCs inferred from Markdown lore.
                await saveNPCLedger(campaign.id, [...existing.filter(n => !npcs.some(i => i.id === n.id || i.name.toLowerCase() === n.name.toLowerCase())), ...npcs]);
                const extraLore = roster.flatMap(e => [...e.characterSheets, ...(e.includeLore ? e.loreChunks : [])]);
                if (extraLore.length) {
                    const existingLore = await getLoreChunks(campaign.id);
                    await saveLoreChunks(campaign.id, [...existingLore.filter(c => !extraLore.some(i => i.id === c.id)), ...extraLore]);
                }
            }
            if (world?.warnings.length) toast.info(world.warnings.join(' '));
            if (!isEdit) await hydrateCampaign(campaign.id);
            resetForm(); onDone();
        } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not save campaign.'); }
        finally { saveLock.current = false; setSaving(false); }
    };
    const clearCover = () => { setCoverFile(null); setCoverPreview(''); };
    return {
        name, setName, coverFile, coverPreview, handleCoverChange, clearCover,
        loreFile, setLoreFile, loreName, setLoreName,
        rulesFile, setRulesFile, rulesName, setRulesName,
        lootFile, setLootFile, lootName, setLootName,
        resetForm, openCreate, openEdit, handleSave, editingCampaign,
        roster, setRoster, preparedWorld, setPreparedWorld, saving,
    };
}

import { useState } from 'react';
import { Plus, Trash2, Copy } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { AIPreset, SamplingConfig } from '../../types';
import { uid } from '../../utils/uid';
import { SamplingPanel } from '../SamplingPanel';

export function PresetsTab() {
  const { settings, addPreset, updatePreset, removePreset } = useAppStore();
  const [activeTab, setActiveTab] = useState(settings.presets[0]?.id || '');

  const activePreset = settings.presets.find((p) => p.id === activeTab) || settings.presets[0];

  const handleAddPreset = () => {
    const firstProviderId = settings.providers[0]?.id || '';
    const newPreset: AIPreset = {
      id: uid(),
      name: `Preset ${settings.presets.length + 1}`,
      storyAIProviderId: firstProviderId,
      summarizerAIProviderId: '',
      utilityAIProviderId: '',
      auxiliaryAIProviderId: '',
      imageAIProviderId: '',
    };
    addPreset(newPreset);
    setActiveTab(newPreset.id);
  };

  const handleDuplicatePreset = () => {
    if (!activePreset) return;
    const duplicated: AIPreset = {
      ...activePreset,
      id: uid(),
      name: `${activePreset.name} (copy)`,
    };
    addPreset(duplicated);
    setActiveTab(duplicated.id);
  };

  const handleRemovePreset = (id: string) => {
    if (settings.presets.length <= 1) return;
    removePreset(id);
    const updatedPresets = useAppStore.getState().settings.presets;
    setActiveTab(updatedPresets[0]?.id || '');
  };

  const handleUpdatePresetName = (name: string) => {
    if (!activePreset) return;
    updatePreset(activePreset.id, { name });
  };

  return (
    <>
      {/* ─── Preset Tabs ─── */}
      <div className="flex flex-col mb-6">
        <label className="text-text-dim text-xs uppercase tracking-widest mb-2 font-bold">AI Presets</label>
        <div className="flex items-center gap-1 border-b border-border overflow-x-auto pb-px">
          {settings.presets.map((p) => (
            <button
              key={p.id}
              onClick={() => setActiveTab(p.id)}
              className={`px-3 py-2 text-[11px] uppercase tracking-wider whitespace-nowrap transition-all border-b-2 -mb-px ${activeTab === p.id
                ? 'text-terminal border-terminal bg-terminal/5 font-bold'
                : 'text-text-dim border-transparent hover:text-text-primary hover:border-border'
              }`}
            >
              {p.name}
            </button>
          ))}
          <button
            onClick={handleAddPreset}
            className="px-3 py-2 text-text-dim hover:text-terminal transition-colors -mb-px border-b-2 border-transparent"
            title="Add Preset"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* ─── Active Preset Config ─── */}
      {activePreset && (
        <div className="mb-8 animate-in fade-in duration-200">
          <div className="flex gap-2 items-end mb-6">
            <div className="flex-1">
              <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Preset Name</label>
              <input
                type="text"
                value={activePreset.name}
                onChange={(e) => handleUpdatePresetName(e.target.value)}
                className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-bold focus:border-terminal focus:outline-none"
                placeholder="e.g. Local Heavy"
              />
            </div>
            <button
              onClick={handleDuplicatePreset}
              className="bg-void border border-border text-text-dim hover:text-terminal hover:border-terminal transition-colors px-3 py-2"
              title="Duplicate preset"
            >
              <Copy size={16} />
            </button>
            {settings.presets.length > 1 && (
              <button
                onClick={() => handleRemovePreset(activePreset.id)}
                className="bg-void border border-danger/40 hover:border-danger text-danger px-4 py-2 hover:bg-danger/10 transition-all flex border-dashed focus:outline-none"
                title="Delete this preset"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>

          {/* ─── Provider dropdowns ─── */}
          {/* WO-12.1 — 2-column grid on wide viewports; the required Story AI
              field spans every column to keep the * marker visible without
              squeeze. Stacks to a single column on narrow/mobile, and goes to
              three across once the pane is full-stretch — five selectors in two
              columns leaves a ragged half-empty last row. */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 md:gap-4 space-y-4 md:space-y-0 mb-6">
            <div className="md:col-span-2 xl:col-span-3">
              <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Story &amp; Logic AI <span className="text-terminal">*</span></label>
              <select
                value={activePreset.storyAIProviderId}
                onChange={(e) => updatePreset(activePreset.id, { storyAIProviderId: e.target.value })}
                className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary focus:border-terminal focus:outline-none appearance-none"
              >
                {settings.providers.map(p => (
                  <option key={p.id} value={p.id}>{p.label || p.modelName || p.endpoint}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Summarizer &amp; Context AI</label>
              <select
                value={activePreset.summarizerAIProviderId || ''}
                onChange={(e) => updatePreset(activePreset.id, { summarizerAIProviderId: e.target.value })}
                className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary focus:border-terminal focus:outline-none appearance-none"
              >
                <option value="">Fallback to Story AI</option>
                {settings.providers.map(p => (
                  <option key={p.id} value={p.id}>{p.label || p.modelName || p.endpoint}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Image Generation AI</label>
              <select
                value={activePreset.imageAIProviderId || ''}
                onChange={(e) => updatePreset(activePreset.id, { imageAIProviderId: e.target.value })}
                className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary focus:border-terminal focus:outline-none appearance-none"
              >
                <option value="">None</option>
                {settings.providers.map(p => (
                  <option key={p.id} value={p.id}>{p.label || p.modelName || p.endpoint}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Utility AI (Context Recommender)</label>
              <select
                value={activePreset.utilityAIProviderId || ''}
                onChange={(e) => updatePreset(activePreset.id, { utilityAIProviderId: e.target.value })}
                className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary focus:border-terminal focus:outline-none appearance-none"
              >
                <option value="">None</option>
                {settings.providers.map(p => (
                  <option key={p.id} value={p.id}>{p.label || p.modelName || p.endpoint}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Auxiliary AI (NPC Classification)</label>
              <select
                value={activePreset.auxiliaryAIProviderId || ''}
                onChange={(e) => updatePreset(activePreset.id, { auxiliaryAIProviderId: e.target.value })}
                className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary focus:border-terminal focus:outline-none appearance-none"
              >
                <option value="">None</option>
                {settings.providers.map(p => (
                  <option key={p.id} value={p.id}>{p.label || p.modelName || p.endpoint}</option>
                ))}
              </select>
            </div>
          </div>

          <SamplingPanel
            preset={activePreset}
            onUpdate={(sampling: SamplingConfig) => updatePreset(activePreset.id, { sampling })}
          />
        </div>
      )}
    </>
  );
}
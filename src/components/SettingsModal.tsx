import { useState } from 'react';
import { X, Loader2, CheckCircle, XCircle, Plus, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { testConnection } from '../services/chatEngine';
import type { ProviderConfig } from '../types';

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function SettingsModal() {
    const { settings, updateSettings, settingsOpen, toggleSettings, addProvider, updateProvider, removeProvider } = useAppStore();
    const [activeTab, setActiveTab] = useState(settings.providers[0]?.id || '');
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

    if (!settingsOpen) return null;

    const activeProviderConfig = settings.providers.find((p) => p.id === activeTab) || settings.providers[0];

    const handleTest = async () => {
        if (!activeProviderConfig) return;
        setTesting(true);
        setTestResult(null);
        const result = await testConnection(activeProviderConfig);
        setTestResult(result);
        setTesting(false);
    };

    const handleAddProvider = () => {
        const newProvider: ProviderConfig = {
            id: uid(),
            label: `Provider ${settings.providers.length + 1}`,
            endpoint: 'http://localhost:11434/v1',
            apiKey: '',
            modelName: 'llama3',
        };
        addProvider(newProvider);
        setActiveTab(newProvider.id);
        setTestResult(null);
    };

    const handleRemoveProvider = (id: string) => {
        if (settings.providers.length <= 1) return;
        removeProvider(id);
        setActiveTab(settings.providers[0]?.id || '');
        setTestResult(null);
    };

    const handleUpdateField = (field: keyof ProviderConfig, value: string) => {
        if (!activeProviderConfig) return;
        updateProvider(activeProviderConfig.id, { [field]: value });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-ember/40 backdrop-blur-sm"
                onClick={toggleSettings}
            />

            {/* Panel */}
            <div className="relative bg-surface border border-border w-full max-w-lg mx-4 p-6">
                <div className="flex items-center justify-between mb-6">
                    <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase glow-green">
                        ⚙ SETTINGS
                    </h2>
                    <button
                        onClick={toggleSettings}
                        className="text-text-dim hover:text-danger transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* ─── Provider Tabs ─── */}
                <div className="flex items-center gap-1 mb-4 border-b border-border overflow-x-auto pb-px">
                    {settings.providers.map((p) => (
                        <button
                            key={p.id}
                            onClick={() => { setActiveTab(p.id); setTestResult(null); }}
                            className={`px-3 py-1.5 text-[11px] uppercase tracking-wider whitespace-nowrap transition-all border-b-2 -mb-px ${activeTab === p.id
                                ? 'text-ice border-ice'
                                : 'text-text-dim border-transparent hover:text-text-primary hover:border-border'
                                }`}
                        >
                            {p.label}
                        </button>
                    ))}
                    <button
                        onClick={handleAddProvider}
                        className="px-2 py-1.5 text-text-dim hover:text-terminal transition-colors -mb-px border-b-2 border-transparent"
                        title="Add provider"
                    >
                        <Plus size={14} />
                    </button>
                </div>

                {/* ─── Active Provider Config ─── */}
                {activeProviderConfig && (
                    <div className="space-y-4">
                        {/* Label */}
                        <div>
                            <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">
                                Label
                            </label>
                            <input
                                type="text"
                                value={activeProviderConfig.label}
                                onChange={(e) => handleUpdateField('label', e.target.value)}
                                placeholder="e.g. DS-Chat, Opus, Local"
                                className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono"
                            />
                        </div>

                        {/* Endpoint */}
                        <div>
                            <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">
                                API Endpoint
                            </label>
                            <input
                                type="text"
                                value={activeProviderConfig.endpoint}
                                onChange={(e) => handleUpdateField('endpoint', e.target.value)}
                                placeholder="http://localhost:11434/v1"
                                className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono"
                            />
                        </div>

                        {/* Model */}
                        <div>
                            <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">
                                Model Name
                            </label>
                            <input
                                type="text"
                                value={activeProviderConfig.modelName}
                                onChange={(e) => handleUpdateField('modelName', e.target.value)}
                                placeholder="llama3"
                                className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono"
                            />
                        </div>

                        {/* API Key */}
                        <div>
                            <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">
                                API Key <span className="text-text-dim/60">(empty for local)</span>
                            </label>
                            <input
                                type="password"
                                value={activeProviderConfig.apiKey}
                                onChange={(e) => handleUpdateField('apiKey', e.target.value)}
                                placeholder="sk-..."
                                className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono"
                            />
                        </div>

                        {/* Test + Delete row */}
                        <div className="flex gap-2">
                            <button
                                onClick={handleTest}
                                disabled={testing}
                                className="flex-1 bg-void border border-terminal/40 hover:border-terminal text-terminal text-xs uppercase tracking-widest py-2 transition-all hover:glow-border disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {testing ? (
                                    <>
                                        <Loader2 size={14} className="animate-spin" />
                                        Testing...
                                    </>
                                ) : (
                                    'Test Connection'
                                )}
                            </button>

                            {settings.providers.length > 1 && (
                                <button
                                    onClick={() => handleRemoveProvider(activeProviderConfig.id)}
                                    className="bg-void border border-danger/40 hover:border-danger text-danger text-xs uppercase tracking-widest px-3 py-2 transition-all flex items-center gap-1.5"
                                    title="Delete this provider"
                                >
                                    <Trash2 size={13} />
                                </button>
                            )}
                        </div>

                        {testResult && (
                            <div
                                className={`flex items-center gap-2 text-xs px-3 py-2 border ${testResult.ok
                                    ? 'border-terminal/30 text-terminal bg-terminal/5'
                                    : 'border-danger/30 text-danger bg-danger/5'
                                    }`}
                            >
                                {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                                {testResult.detail}
                            </div>
                        )}
                    </div>
                )}

                {/* ─── Global Settings ─── */}
                <div className="mt-6 pt-4 border-t border-border space-y-4">
                    {/* Context Limit */}
                    <div>
                        <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">
                            Context Limit: <span className="text-terminal">{settings.contextLimit}</span> tokens
                        </label>
                        <input
                            type="range"
                            min={1024}
                            max={131072}
                            step={512}
                            value={settings.contextLimit}
                            onChange={(e) => updateSettings({ contextLimit: Number(e.target.value) })}
                            className="w-full accent-terminal"
                        />
                        <div className="flex justify-between text-[10px] text-text-dim">
                            <span>1K</span>
                            <span>128K</span>
                        </div>
                    </div>

                    {/* Auto-Condense */}
                    <div className="flex items-center justify-between">
                        <label className="text-[11px] text-text-dim uppercase tracking-wider">
                            Auto-Condense
                        </label>
                        <button
                            onClick={() => updateSettings({ autoCondenseEnabled: !settings.autoCondenseEnabled })}
                            className={`relative w-9 h-4.5 rounded-full transition-colors ${settings.autoCondenseEnabled ? 'bg-terminal' : 'bg-border'}`}
                        >
                            <div
                                className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-surface transition-transform ${settings.autoCondenseEnabled ? 'translate-x-4.5' : 'translate-x-0.5'}`}
                            />
                        </button>
                    </div>
                    {settings.autoCondenseEnabled && (
                        <p className="text-[9px] text-text-dim/50 -mt-2">
                            Automatically compresses old history when tokens exceed 40% of context limit
                        </p>
                    )}

                    {/* Debug Mode */}
                    <div className="flex items-center justify-between">
                        <label className="text-[11px] text-text-dim uppercase tracking-wider">
                            Debug Payload Viewer
                        </label>
                        <button
                            onClick={() => updateSettings({ debugMode: !settings.debugMode })}
                            className={`relative w-9 h-4.5 rounded-full transition-colors ${settings.debugMode ? 'bg-terminal' : 'bg-border'}`}
                        >
                            <div
                                className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-surface transition-transform ${settings.debugMode ? 'translate-x-4.5' : 'translate-x-0.5'}`}
                            />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

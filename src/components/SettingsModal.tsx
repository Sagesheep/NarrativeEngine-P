import { useState, useRef } from 'react';
import { X, Loader2, CheckCircle, XCircle, Plus, Trash2, ChevronDown, ChevronRight, Download, Upload, Lock } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { testConnection } from '../services/chatEngine';
import type { AIPreset, EndpointConfig, ApiFormat, SamplingConfig } from '../types';
import { detectFormatFromEndpoint } from '../utils/llmApiHelper';
import { toast } from './Toast';
import { uid } from '../utils/uid';
import { SamplingPanel } from './SamplingPanel';

export function SettingsModal() {
    const { settings, updateSettings, settingsOpen, toggleSettings, addPreset, updatePreset, removePreset } = useAppStore();
    const [activeTab, setActiveTab] = useState(settings.presets[0]?.id || '');
    const [testingSection, setTestingSection] = useState<'storyAI' | 'imageAI' | 'summarizerAI' | 'utilityAI' | null>(null);
    const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string } | null>>({});

    const [expanded, setExpanded] = useState<Record<string, boolean>>({
        storyAI: true,
        imageAI: false,
        summarizerAI: false,
        utilityAI: false,
    });

    if (!settingsOpen) return null;

    const activePreset = settings.presets.find((p) => p.id === activeTab) || settings.presets[0];

    const handleTest = async (section: 'storyAI' | 'imageAI' | 'summarizerAI' | 'utilityAI') => {
        if (!activePreset) return;
        const config = activePreset[section];
        if (!config || !config.endpoint) return;

        setTestingSection(section);
        setTestResults(prev => ({ ...prev, [section]: null }));
        const result = await testConnection(config);
        setTestResults(prev => ({ ...prev, [section]: result }));
        setTestingSection(null);
        if (result.ok) {
            toast.success(`${section} connection successful`);
        } else {
            toast.error(`${section} connection failed: ${result.detail}`);
        }
    };

    const handleAddPreset = () => {
        const newPreset: AIPreset = {
            id: uid(),
            name: `Preset ${settings.presets.length + 1}`,
            storyAI: { endpoint: 'http://localhost:11434/v1', apiKey: '', modelName: 'llama3', apiFormat: 'openai' },
            imageAI: { endpoint: '', apiKey: '', modelName: '' },
            summarizerAI: { endpoint: 'http://localhost:11434/v1', apiKey: '', modelName: 'llama3', apiFormat: 'openai' },
            utilityAI: { endpoint: '', apiKey: '', modelName: '' }
        };
        addPreset(newPreset);
        setActiveTab(newPreset.id);
        setTestResults({});
    };

    const handleRemovePreset = (id: string) => {
        if (settings.presets.length <= 1) return;
        removePreset(id);
        setActiveTab(settings.presets[0]?.id || '');
        setTestResults({});
    };

    const handleUpdatePresetName = (name: string) => {
        if (!activePreset) return;
        updatePreset(activePreset.id, { name });
    };

    const handleUpdateEndpoint = (section: 'storyAI' | 'imageAI' | 'summarizerAI' | 'utilityAI', field: keyof EndpointConfig, value: string) => {
        if (!activePreset) return;
        const updatedConfig = { ...activePreset[section], [field]: value };
        updatePreset(activePreset.id, { [section]: updatedConfig });
    };

    const handleApiFormatChange = (section: 'storyAI' | 'imageAI' | 'summarizerAI' | 'utilityAI', newFormat: ApiFormat) => {
        if (!activePreset) return;
        const config = activePreset[section] ?? { endpoint: '', apiKey: '', modelName: '' };
        let endpoint = (config.endpoint || '').replace(/\/+$/, '');
        if (newFormat === 'ollama') {
            endpoint = endpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
        } else if (newFormat === 'claude') {
            endpoint = 'https://api.anthropic.com/v1';
        } else if (newFormat === 'gemini') {
            endpoint = 'https://generativelanguage.googleapis.com/v1beta';
        } else {
            // OpenAI format — if endpoint looks like a bare Ollama host, add /v1
            if (/localhost:11434|127\.0\.0\.1:11434/.test(endpoint) && !endpoint.endsWith('/v1')) {
                endpoint = endpoint + '/v1';
            }
        }
        updatePreset(activePreset.id, { [section]: { ...config, apiFormat: newFormat, endpoint } });
    };

    const handleEndpointBlur = (section: 'storyAI' | 'imageAI' | 'summarizerAI' | 'utilityAI', endpoint: string) => {
        if (!activePreset || !endpoint) return;
        const detected = detectFormatFromEndpoint(endpoint);
        if (!detected) return;
        const config = activePreset[section] ?? { endpoint: '', apiKey: '', modelName: '' };
        const currentFormat = (config as EndpointConfig).apiFormat || 'openai';
        if (currentFormat === detected) return;
        let normalizedEndpoint = endpoint.replace(/\/+$/, '');
        if (detected === 'ollama') {
            normalizedEndpoint = normalizedEndpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
        }
        updatePreset(activePreset.id, { [section]: { ...config, apiFormat: detected, endpoint: normalizedEndpoint } });
    };

    const toggleSection = (section: string) => {
        setExpanded(prev => ({ ...prev, [section]: !prev[section] }));
    };

    const handleUpdateSampling = (sampling: SamplingConfig) => {
        if (!activePreset) return;
        updatePreset(activePreset.id, { sampling });
    };

    const renderEndpointConfig = (section: 'storyAI' | 'imageAI' | 'summarizerAI' | 'utilityAI', title: string) => {
        const config = activePreset[section] ?? { endpoint: '', apiKey: '', modelName: '', apiFormat: 'openai' as ApiFormat };
        const isExpanded = expanded[section];
        const isTesting = testingSection === section;
        const result = testResults[section];
        const currentFormat = (config.apiFormat || 'openai') as ApiFormat;
        const isImageSection = section === 'imageAI';
        const availableFormats: ApiFormat[] = isImageSection
            ? ['openai', 'ollama']
            : ['openai', 'ollama', 'claude', 'gemini'];

        const formatLabel = (fmt: ApiFormat): string => {
            switch (fmt) {
                case 'openai': return 'OpenAI';
                case 'ollama': return 'Ollama';
                case 'claude': return 'Claude';
                case 'gemini': return 'Gemini';
            }
        };

        const endpointPlaceholder = (): string => {
            switch (currentFormat) {
                case 'ollama': return 'http://localhost:11434';
                case 'claude': return 'https://api.anthropic.com/v1';
                case 'gemini': return 'https://generativelanguage.googleapis.com/v1beta';
                default: return 'http://localhost:11434/v1';
            }
        };

        return (
            <div className="border border-border rounded mb-3 bg-void-lighter overflow-hidden">
                <button
                    onClick={() => toggleSection(section)}
                    className="w-full flex items-center justify-between p-3 bg-void hover:bg-surface transition-colors"
                >
                    <div className="flex items-center gap-2 text-sm font-bold text-text-primary uppercase tracking-wider">
                        {isExpanded ? <ChevronDown size={16} className="text-terminal" /> : <ChevronRight size={16} className="text-text-dim" />}
                        {title}
                    </div>
                </button>

                {isExpanded && (
                    <div className="p-4 space-y-4 border-t border-border bg-void">
                        <div>
                            <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Endpoint</label>
                            <input
                                type="text"
                                value={config.endpoint}
                                onChange={(e) => handleUpdateEndpoint(section, 'endpoint', e.target.value)}
                                onBlur={(e) => handleEndpointBlur(section, e.target.value)}
                                placeholder={endpointPlaceholder()}
                                className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                            />
                            {currentFormat === 'ollama' && (
                                <p className="text-[10px] text-text-dim mt-1">
                                    Local: <span className="font-mono">http://localhost:11434</span> &middot; Cloud: <span className="font-mono">https://api.ollama.com</span> (needs API key)
                                </p>
                            )}
                            {currentFormat === 'claude' && (
                                <p className="text-[10px] text-text-dim mt-1">
                                    <span className="font-mono">https://api.anthropic.com/v1</span> &middot; Uses <span className="font-mono">x-api-key</span> header
                                </p>
                            )}
                            {currentFormat === 'gemini' && (
                                <p className="text-[10px] text-text-dim mt-1">
                                    <span className="font-mono">https://generativelanguage.googleapis.com/v1beta</span> &middot; Key goes in URL
                                </p>
                            )}
                        </div>
                        <div>
                            <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Format</label>
                            <div className="flex border border-border overflow-hidden rounded">
                                {availableFormats.map(fmt => (
                                    <button
                                        key={fmt}
                                        onClick={() => handleApiFormatChange(section, fmt)}
                                        className={`flex-1 px-3 py-2 text-[10px] uppercase tracking-wider transition-colors focus:outline-none ${currentFormat === fmt ? 'bg-terminal text-surface font-bold' : 'bg-void text-text-dim hover:text-text-primary'}`}
                                    >
                                        {formatLabel(fmt)}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Model Name</label>
                            <input
                                type="text"
                                value={config.modelName}
                                onChange={(e) => handleUpdateEndpoint(section, 'modelName', e.target.value)}
                                placeholder={currentFormat === 'claude' ? 'claude-sonnet-4-20250514' : currentFormat === 'gemini' ? 'gemini-2.0-flash' : 'llama3'}
                                className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                            />
                        </div>
                        <div>
                            <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Key <span className="text-text-dim/60">(empty for local)</span></label>
                            <input
                                type="password"
                                value={config.apiKey}
                                onChange={(e) => handleUpdateEndpoint(section, 'apiKey', e.target.value)}
                                placeholder={currentFormat === 'gemini' ? 'AIza...' : 'sk-...'}
                                className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                            />
                        </div>

                        <div className="pt-2">
                            <button
                                onClick={() => handleTest(section)}
                                disabled={isTesting || !config.endpoint}
                                className="w-full bg-surface border border-terminal/40 hover:border-terminal text-terminal text-xs uppercase tracking-widest py-2 transition-all hover:glow-border disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {isTesting ? <><Loader2 size={14} className="animate-spin" /> Testing...</> : 'Test Connection'}
                            </button>
                            {result && (
                                <div className={`flex items-center gap-2 text-xs px-3 py-2 border mt-2 ${result.ok ? 'border-terminal/30 text-terminal bg-terminal/5' : 'border-danger/30 text-danger bg-danger/5'}`}>
                                    {result.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                                    {result.detail}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center" role="dialog" aria-modal="true" aria-label="Settings">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-ember/40 backdrop-blur-sm" onClick={toggleSettings} />

            {/* Panel */}
            <div className="relative bg-surface border border-border w-full h-full sm:h-[85vh] sm:max-w-xl sm:mx-4 flex flex-col shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between p-4 sm:p-6 border-b border-border shrink-0 bg-void z-10">
                    <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase glow-green">
                        ⚙ SETTINGS
                    </h2>
                    <button onClick={toggleSettings} className="text-text-dim hover:text-danger transition-colors">
                        <X size={18} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 sm:p-6 pb-20">
                    {/* ─── Preset Tabs ─── */}
                    <div className="flex flex-col mb-6">
                        <label className="text-text-dim text-xs uppercase tracking-widest mb-2 font-bold">AI Presets</label>
                        <div className="flex items-center gap-1 border-b border-border overflow-x-auto pb-px">
                            {settings.presets.map((p) => (
                                <button
                                    key={p.id}
                                    onClick={() => { setActiveTab(p.id); setTestResults({}); }}
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

                            {renderEndpointConfig('storyAI', 'Story & Logic AI')}
                            {renderEndpointConfig('summarizerAI', 'Summarizer & Context AI')}
                            {renderEndpointConfig('imageAI', 'Image Generation AI')}
                            {renderEndpointConfig('utilityAI', 'Utility AI (Context Recommender)')}

                            <SamplingPanel preset={activePreset} onUpdate={handleUpdateSampling} />
                        </div>
                    )}

                    {/* ─── Global Settings ─── */}
                    <div className="mt-8 pt-6 border-t border-border space-y-6">
                        <label className="text-text-dim text-xs uppercase tracking-widest font-bold block mb-4">Global Preferences</label>

                        {/* Context Limit */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-[11px] text-text-dim uppercase tracking-wider">
                                    Max Context Limit (Tokens)
                                </label>
                                <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-xs">
                                    {settings.contextLimit.toLocaleString()}
                                </span>
                            </div>

                            <input
                                type="number"
                                min={0}
                                step={1024}
                                value={settings.contextLimit || 0}
                                onChange={(e) => updateSettings({ contextLimit: Math.max(0, parseInt(e.target.value) || 0) })}
                                className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary font-mono mb-2 focus:border-terminal focus:outline-none"
                            />

                            <div className="flex flex-wrap gap-1.5">
                                {[4096, 8192, 16384, 32768, 65536, 131072, 262144, 1048576, 2097152].map(limit => (
                                    <button
                                        key={limit}
                                        onClick={() => updateSettings({ contextLimit: limit })}
                                        className={`px-2 py-1 text-[10px] uppercase font-mono border rounded transition-colors focus:outline-none ${settings.contextLimit === limit ? 'bg-terminal text-void border-terminal' : 'bg-surface border-border text-text-dim hover:text-text-primary hover:border-text-dim'}`}
                                    >
                                        {limit >= 1048576 ? `${limit / 1048576}M` : `${limit / 1024}K`}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Debug Mode */}
                        <div className="flex items-center justify-between bg-void p-3 border border-border rounded">
                            <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold">
                                Debug Payload Viewer
                            </label>
                            <button
                                onClick={() => updateSettings({ debugMode: !settings.debugMode })}
                                className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${settings.debugMode ? 'bg-terminal' : 'bg-border'}`}
                            >
                                <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.debugMode ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
                            </button>
                        </div>

                        {/* Show Reasoning */}
                        <div className="flex items-center justify-between bg-void p-3 border border-border rounded">
                            <div>
                                <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
                                    Show Reasoning (Thinking Blocks)
                                </label>
                                <p className="text-[9px] text-text-dim max-w-[200px] leading-tight">
                                    Show or hide the model's internal thinking process (&lt;think&gt; blocks)
                                </p>
                            </div>
                            <button
                                onClick={() => updateSettings({ showReasoning: !settings.showReasoning })}
                                className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${settings.showReasoning ? 'bg-terminal' : 'bg-border'}`}
                            >
                                <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.showReasoning ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
                            </button>
                        </div>

                        {/* Theme */}
                        <div className="flex items-center justify-between bg-void p-3 border border-border rounded">
                            <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold">
                                UI Theme
                            </label>
                            <div className="flex border border-border overflow-hidden rounded">
                                <button
                                    onClick={() => updateSettings({ theme: 'light' })}
                                    className={`px-4 py-1.5 text-[10px] uppercase tracking-wider transition-colors focus:outline-none ${(settings.theme ?? 'light') === 'light'
                                        ? 'bg-terminal text-surface font-bold'
                                        : 'bg-void text-text-dim hover:text-text-primary'
                                        }`}
                                >
                                    ☀ Light
                                </button>
                                <button
                                    onClick={() => updateSettings({ theme: 'dark' })}
                                    className={`px-4 py-1.5 text-[10px] uppercase tracking-wider transition-colors border-l border-border focus:outline-none ${settings.theme === 'dark'
                                        ? 'bg-terminal text-surface font-bold'
                                        : 'bg-void text-text-dim hover:text-text-primary'
                                        }`}
                                >
                                    ☽ Dark
                                </button>
                            </div>
                        </div>

                        {/* Vault Export/Import */}
                        <VaultSection />
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Vault Section Component ───────────────────────────────────────────

function VaultSection() {
    const { vaultStatus, exportVault, importVault, saveVaultKeys } = useAppStore();
    const [isExporting, setIsExporting] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [exportPassword, setExportPassword] = useState('');
    const [importPassword, setImportPassword] = useState('');
    const [showExportPassword, setShowExportPassword] = useState(false);
    const [showImportPassword, setShowImportPassword] = useState(false);
    const [mergeImport, setMergeImport] = useState(true);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleExport = async () => {
        if (!exportPassword) {
            toast.error('Please enter an export password');
            return;
        }
        setIsExporting(true);
        try {
            // First save current keys to vault
            await saveVaultKeys();
            const blob = await exportVault(exportPassword);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'narrative-engine-keys.nevault';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            toast.success('Vault exported - share the .nevault file and password separately');
            setExportPassword('');
        } catch (e) {
            toast.error('Export failed');
        } finally {
            setIsExporting(false);
        }
    };

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!importPassword) {
            toast.error('Please enter the import password first');
            return;
        }

        setIsImporting(true);
        try {
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const base64 = btoa(String.fromCharCode(...new Uint8Array(event.target?.result as ArrayBuffer)));
                    await importVault(base64, importPassword, mergeImport);
                    setImportPassword('');
                    if (fileInputRef.current) fileInputRef.current.value = '';
                } catch (err) {
                    toast.error('Import failed - wrong password or corrupted file');
                } finally {
                    setIsImporting(false);
                }
            };
            reader.readAsArrayBuffer(file);
        } catch (e) {
            toast.error('Failed to read file');
            setIsImporting(false);
        }
    };

    // Don't show if vault doesn't exist
    if (!vaultStatus?.exists) {
        return null;
    }

    return (
        <div className="mt-8 pt-6 border-t border-border space-y-4">
            <div className="flex items-center gap-2 mb-2">
                <Lock size={14} className="text-terminal" />
                <label className="text-text-dim text-xs uppercase tracking-widest font-bold">
                    Vault Export/Import
                </label>
            </div>

            <div className="grid grid-cols-1 gap-4">
                {/* Export Section */}
                <div className="bg-void border border-border p-4 rounded">
                    <p className="text-[11px] text-text-dim uppercase tracking-wider mb-3">Export Vault</p>
                    <p className="text-[10px] text-text-dim/70 mb-3">
                        Create an encrypted file to share your API keys with others. They&apos;ll need the separate password to decrypt.
                    </p>
                    <div className="flex gap-2">
                        <div className="flex-1 relative">
                            <input
                                type={showExportPassword ? 'text' : 'password'}
                                value={exportPassword}
                                onChange={(e) => setExportPassword(e.target.value)}
                                placeholder="Export password"
                                className="w-full bg-surface border border-border px-3 py-2 pr-8 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                            />
                            <button
                                type="button"
                                onClick={() => setShowExportPassword(!showExportPassword)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text-primary"
                            >
                                {showExportPassword ? 'Hide' : 'Show'}
                            </button>
                        </div>
                        <button
                            onClick={handleExport}
                            disabled={isExporting || !exportPassword}
                            className="bg-surface border border-terminal/40 hover:border-terminal text-terminal text-xs uppercase tracking-widest px-4 py-2 transition-all disabled:opacity-50 flex items-center gap-2"
                        >
                            {isExporting ? (
                                <><Loader2 size={14} className="animate-spin" />...</>
                            ) : (
                                <><Download size={14} /> Export</>
                            )}
                        </button>
                    </div>
                </div>

                {/* Import Section */}
                <div className="bg-void border border-border p-4 rounded">
                    <p className="text-[11px] text-text-dim uppercase tracking-wider mb-3">Import Vault</p>
                    <p className="text-[10px] text-text-dim/70 mb-3">
                        Import an encrypted vault file. Current presets will be merged or replaced based on your selection.
                    </p>

                    <div className="flex items-center gap-2 mb-3">
                        <input
                            type="checkbox"
                            id="mergeImport"
                            checked={mergeImport}
                            onChange={(e) => setMergeImport(e.target.checked)}
                            className="w-4 h-4 accent-terminal"
                        />
                        <label htmlFor="mergeImport" className="text-xs text-text-dim">Merge with existing presets</label>
                    </div>

                    <div className="flex gap-2 mb-3">
                        <div className="flex-1 relative">
                            <input
                                type={showImportPassword ? 'text' : 'password'}
                                value={importPassword}
                                onChange={(e) => setImportPassword(e.target.value)}
                                placeholder="Import password"
                                className="w-full bg-surface border border-border px-3 py-2 pr-8 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                            />
                            <button
                                type="button"
                                onClick={() => setShowImportPassword(!showImportPassword)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text-primary"
                            >
                                {showImportPassword ? 'Hide' : 'Show'}
                            </button>
                        </div>
                    </div>

                    <div className="flex gap-2">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".nevault"
                            onChange={handleFileSelect}
                            className="hidden"
                        />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isImporting || !importPassword}
                            className="w-full bg-surface border border-border hover:border-terminal text-text-primary text-xs uppercase tracking-widest px-4 py-2 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            {isImporting ? (
                                <><Loader2 size={14} className="animate-spin" /> Importing...</>
                            ) : (
                                <><Upload size={14} /> Select .nevault File</>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

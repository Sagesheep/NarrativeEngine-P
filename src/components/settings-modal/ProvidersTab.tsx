import { useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { testConnection } from '../../services/chatEngine';
import type { LLMProvider, ApiFormat, ThinkingEffort, ComfyUiSettings } from '../../types';
import { detectFormatFromEndpoint } from '../../utils/llmApiHelper';
import { toast } from '../Toast';
import { uid } from '../../utils/uid';

const COMFY_DEFAULT_ENDPOINT = 'http://127.0.0.1:8188';

function getEndpointPlaceholder(apiFormat?: ApiFormat) {
    const fmt = apiFormat || 'openai';
    if (fmt === 'ollama') return 'http://localhost:11434  or  https://ollama.com';
    if (fmt === 'claude') return 'https://api.anthropic.com/v1';
    if (fmt === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta';
    if (fmt === 'comfyui') return COMFY_DEFAULT_ENDPOINT;
    return 'http://localhost:11434/v1';
}

function getApiKeyPlaceholder(apiFormat?: ApiFormat) {
    const fmt = apiFormat || 'openai';
    if (fmt === 'ollama') return 'Ollama API key (optional for local)';
    if (fmt === 'claude') return 'sk-ant-...';
    if (fmt === 'gemini') return 'AIza...';
    return 'sk-...';
}

export function ProvidersTab() {
    const settings = useAppStore(s => s.settings);
    const addProvider = useAppStore(s => s.addProvider);
    const updateProvider = useAppStore(s => s.updateProvider);
    const removeProvider = useAppStore(s => s.removeProvider);

    const [activeTab, setActiveTab] = useState(settings.providers[0]?.id || '');
    const [isExpanded, setIsExpanded] = useState(true);
    const [isTesting, setIsTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

    const activeProvider = settings.providers.find(p => p.id === activeTab) || settings.providers[0];

    const handleAddProvider = () => {
        const newProvider: LLMProvider = {
            id: uid(),
            label: `Provider ${settings.providers.length + 1}`,
            endpoint: 'http://localhost:11434/v1',
            apiKey: '',
            modelName: '',
            apiFormat: 'openai',
            streamingEnabled: true,
        };
        addProvider(newProvider);
        setActiveTab(newProvider.id);
        setTestResult(null);
    };

    const handleRemoveProvider = (id: string) => {
        if (settings.providers.length <= 1) return;
        removeProvider(id);
        const remaining = settings.providers.filter(p => p.id !== id);
        setActiveTab(remaining[0]?.id || '');
        setTestResult(null);
    };

    const handleFieldChange = (field: keyof LLMProvider, value: string | boolean | undefined) => {
        if (!activeProvider) return;
        updateProvider(activeProvider.id, { [field]: value });
    };

    const handleApiFormatChange = (newFormat: ApiFormat) => {
        if (!activeProvider) return;
        let endpoint = (activeProvider.endpoint || '').replace(/\/+$/, '');
        if (newFormat === 'ollama') {
            endpoint = endpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
        } else if (newFormat === 'openai' || newFormat === 'claude') {
            if (endpoint && !endpoint.endsWith('/v1') && /localhost:11434|127\.0\.0\.1:11434/.test(endpoint)) {
                endpoint = endpoint + '/v1';
            }
        } else if (newFormat === 'comfyui') {
            // Only auto-fill when the user hasn't set a real endpoint yet — i.e. it's
            // still the Ollama/default value. A custom endpoint is left untouched.
            if (!endpoint || /^https?:\/\/(localhost|127\.0\.0\.1):11434(\/v1)?$/.test(endpoint)) {
                endpoint = COMFY_DEFAULT_ENDPOINT;
            }
        }
        updateProvider(activeProvider.id, { apiFormat: newFormat, endpoint });
    };

    const handleComfyChange = (field: keyof ComfyUiSettings, value: string | number | undefined) => {
        if (!activeProvider) return;
        const nextComfy: ComfyUiSettings = { ...(activeProvider.comfyUi || {}), [field]: value };
        updateProvider(activeProvider.id, { comfyUi: nextComfy });
    };

    const handleComfyNumberChange = (field: keyof ComfyUiSettings, raw: string) => {
        const trimmed = raw.trim();
        if (trimmed === '') {
            handleComfyChange(field, undefined);
            return;
        }
        const n = Number(trimmed);
        handleComfyChange(field, Number.isFinite(n) ? n : undefined);
    };

    const handleEndpointBlur = (endpoint: string) => {
        if (!activeProvider || !endpoint) return;
        const detected = detectFormatFromEndpoint(endpoint);
        if (!detected) return;
        const currentFormat = activeProvider.apiFormat || 'openai';
        if (currentFormat === detected) return;
        let normalizedEndpoint = endpoint.replace(/\/+$/, '');
        if (detected === 'ollama') {
            normalizedEndpoint = normalizedEndpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
        }
        updateProvider(activeProvider.id, { apiFormat: detected, endpoint: normalizedEndpoint });
    };

    const handleTest = async () => {
        if (!activeProvider || !activeProvider.endpoint) return;
        setIsTesting(true);
        setTestResult(null);
        const result = await testConnection(activeProvider);
        setTestResult(result);
        setIsTesting(false);
        if (result.ok) {
            toast.success('Connection successful');
        } else {
            toast.error(`Connection failed: ${result.detail}`);
        }
    };

    const canDelete = settings.providers.length > 1;
    const config = activeProvider;
    const isComfy = (config?.apiFormat || 'openai') === 'comfyui';

    return (
        <div className="flex flex-col">
            <div className="flex flex-col mb-6">
                <label className="text-text-dim text-xs uppercase tracking-widest mb-2 font-bold">Providers</label>
                <div className="flex items-center gap-1 border-b border-border overflow-x-auto pb-px">
                    {settings.providers.map((p) => (
                        <button
                            key={p.id}
                            onClick={() => { setActiveTab(p.id); setTestResult(null); }}
                            className={`px-3 py-2 text-[11px] uppercase tracking-wider whitespace-nowrap transition-all border-b-2 -mb-px ${activeTab === p.id
                                ? 'text-terminal border-terminal bg-terminal/5 font-bold'
                                : 'text-text-dim border-transparent hover:text-text-primary hover:border-border'
                            }`}
                        >
                            {p.label || p.modelName || 'Provider'}
                        </button>
                    ))}
                    <button
                        onClick={handleAddProvider}
                        className="px-3 py-2 text-text-dim hover:text-terminal transition-colors -mb-px border-b-2 border-transparent"
                        title="Add Provider"
                    >
                        <Plus size={14} />
                    </button>
                </div>
            </div>

            {config && (
                <div className="mb-8">
                    <div className="border border-border rounded mb-3 bg-void-lighter overflow-hidden">
                        <button
                            onClick={() => setIsExpanded(!isExpanded)}
                            className="w-full flex items-center justify-between p-3 bg-void hover:bg-surface transition-colors"
                        >
                            <div className="flex items-center gap-2 text-sm font-bold text-text-primary uppercase tracking-wider">
                                {isExpanded ? <ChevronDown size={16} className="text-terminal" /> : <ChevronRight size={16} className="text-text-dim" />}
                                {config.label || config.modelName || 'Provider'}
                            </div>
                        </button>

                        {isExpanded && (
                            <div className="p-4 space-y-4 border-t border-border bg-void">
                                <div>
                                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Label</label>
                                    <input
                                        type="text"
                                        value={config.label}
                                        onChange={(e) => handleFieldChange('label', e.target.value)}
                                        placeholder="My Provider"
                                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 focus:border-terminal focus:outline-none"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Endpoint</label>
                                    <input
                                        type="text"
                                        value={config.endpoint}
                                        onChange={(e) => handleFieldChange('endpoint', e.target.value)}
                                        onBlur={(e) => handleEndpointBlur(e.target.value)}
                                        placeholder={getEndpointPlaceholder(config.apiFormat)}
                                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                                    />
                                    {(config.apiFormat || 'openai') === 'ollama' && (
                                        <p className="text-[10px] text-text-dim mt-1">
                                            Local: <span className="font-mono">http://localhost:11434</span> &middot; Cloud: <span className="font-mono">https://ollama.com</span> (needs API key)
                                        </p>
                                    )}
                                </div>
                                <div>
                                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Format</label>
                                    <div className="flex border border-border overflow-hidden rounded">
                                        {(['openai', 'ollama', 'claude', 'gemini', 'comfyui'] as ApiFormat[]).map(fmt => (
                                            <button
                                                key={fmt}
                                                onClick={() => handleApiFormatChange(fmt)}
                                                className={`flex-1 px-3 py-2 text-[10px] uppercase tracking-wider transition-colors focus:outline-none ${(config.apiFormat || 'openai') === fmt
                                                    ? 'bg-terminal text-surface font-bold'
                                                    : 'bg-void text-text-dim hover:text-text-primary'
                                                }`}
                                            >
                                                {fmt === 'openai' ? 'OpenAI' : fmt === 'ollama' ? 'Ollama' : fmt === 'claude' ? 'Claude' : fmt === 'gemini' ? 'Gemini' : 'ComfyUI'}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">{isComfy ? 'Checkpoint Model Name' : 'Model Name'}</label>
                                    <input
                                        type="text"
                                        value={config.modelName}
                                        onChange={(e) => handleFieldChange('modelName', e.target.value)}
                                        placeholder={isComfy ? 'sd_xl_base_1.0.safetensors' : 'llama3'}
                                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                                    />
                                    {isComfy && (
                                        <p className="text-[10px] text-text-dim mt-1">Checkpoint filename as it appears in ComfyUI's <span className="font-mono">CheckpointLoaderSimple</span>. Used by the built-in graph; ignored if your custom workflow sets its own checkpoint.</p>
                                    )}
                                </div>
                                {isComfy && (
                                    <ComfyUiFields
                                        comfy={config.comfyUi || {}}
                                        onTextChange={handleComfyChange}
                                        onNumberChange={handleComfyNumberChange}
                                    />
                                )}
                                {!isComfy && (
                                    <div>
                                        <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Key</label>
                                        <input
                                            type="password"
                                            value={config.apiKey}
                                            onChange={(e) => handleFieldChange('apiKey', e.target.value)}
                                            placeholder={getApiKeyPlaceholder(config.apiFormat)}
                                            className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                                        />
                                    </div>
                                )}
                                {!isComfy && (
                                    <div className="flex items-center justify-between gap-3 py-2">
                                        <label className="text-[11px] text-text-dim uppercase tracking-wider truncate">Enable Streaming</label>
                                        <button
                                            onClick={() => handleFieldChange('streamingEnabled', config.streamingEnabled === false)}
                                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${config.streamingEnabled !== false ? 'bg-terminal/60' : 'bg-border'}`}
                                            title={config.streamingEnabled !== false ? 'Streaming on — click to disable' : 'Streaming off — click to enable'}
                                        >
                                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${config.streamingEnabled !== false ? 'translate-x-5' : 'translate-x-0'}`} />
                                        </button>
                                    </div>
                                )}
                                {!isComfy && (
                                    <div>
                                        <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1" title="Requests reasoning from the model when supported. 'Max' maps to xhigh on OpenAI, max on DeepSeek V4, HIGH on Gemini.">
                                            Thinking effort
                                        </label>
                                        <div className="flex border border-border overflow-hidden rounded">
                                            {(['off', 'low', 'medium', 'high', 'max'] as ThinkingEffort[]).map(level => (
                                                <button
                                                    key={level}
                                                    onClick={() => handleFieldChange('thinkingEffort', level === 'off' ? undefined : level)}
                                                    className={`flex-1 px-2 py-1.5 text-[9px] uppercase tracking-wider transition-colors focus:outline-none ${(config.thinkingEffort === level) || (!config.thinkingEffort && level === 'off')
                                                        ? 'bg-terminal text-void font-bold'
                                                        : 'bg-void text-text-dim hover:text-text-primary'
                                                    }`}
                                                    title={level === 'max' ? 'OpenAI & DeepSeek cap at High — Max sends High.' : undefined}
                                                >
                                                    {level.charAt(0).toUpperCase() + level.slice(1)}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                <div className="pt-2">
                                    <button
                                        onClick={handleTest}
                                        disabled={isTesting || !config.endpoint}
                                        className="w-full bg-surface border border-terminal/40 hover:border-terminal text-terminal text-xs uppercase tracking-widest py-2 transition-all hover:glow-border disabled:opacity-50 flex items-center justify-center gap-2"
                                    >
                                        {isTesting ? <><Loader2 size={14} className="animate-spin" /> Testing...</> : 'Test Connection'}
                                    </button>
                                    {testResult && (
                                        <div className={`flex items-center gap-2 text-xs px-3 py-2 border mt-2 ${testResult.ok ? 'border-terminal/30 text-terminal bg-terminal/5' : 'border-danger/30 text-danger bg-danger/5'}`}>
                                            {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                                            {testResult.detail}
                                        </div>
                                    )}
                                </div>
                                <div className="pt-2">
                                    <button
                                        onClick={() => handleRemoveProvider(config.id)}
                                        disabled={!canDelete}
                                        className="w-full bg-void border border-danger/40 text-danger text-xs uppercase tracking-widest py-2 transition-all hover:bg-danger/10 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                    >
                                        <Trash2 size={14} /> Delete Provider
                                    </button>
                                    {!canDelete && (
                                        <p className="text-[10px] text-text-dim mt-1 text-center">Cannot delete the last provider</p>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

const COMFY_PLACEHOLDERS = '%prompt%, %negative_prompt%, %seed%, %width%, %height%, %steps%, %cfg%, %sampler%, %scheduler%, %denoise%, %model%';

function ComfyUiFields({
    comfy,
    onTextChange,
    onNumberChange,
}: {
    comfy: ComfyUiSettings;
    onTextChange: (field: keyof ComfyUiSettings, value: string | undefined) => void;
    onNumberChange: (field: keyof ComfyUiSettings, raw: string) => void;
}) {
    return (
        <>
            <div className="border border-terminal/20 bg-terminal/5 rounded px-3 py-2">
                <p className="text-[10px] text-text-dim leading-relaxed">
                    <span className="text-terminal font-bold uppercase tracking-wider">Image Generation AI only.</span>{' '}
                    Point this at a local ComfyUI server. Leave the workflow blank to use the built-in basic txt2img graph, or paste a workflow exported from ComfyUI via <span className="font-mono">Save (API Format)</span>.
                </p>
            </div>

            <div>
                <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Custom API Workflow JSON</label>
                <textarea
                    value={comfy.customWorkflowJson || ''}
                    onChange={(e) => onTextChange('customWorkflowJson', e.target.value || undefined)}
                    rows={6}
                    placeholder='Blank = built-in basic txt2img. Paste a "Save (API Format)" export here to use your own graph.'
                    className="w-full bg-surface border border-border px-3 py-2 text-xs text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none resize-y"
                />
                <p className="text-[10px] text-text-dim mt-1 leading-relaxed">
                    Supported placeholders (substituted before the graph runs):<br />
                    <span className="font-mono text-text-primary/80">{COMFY_PLACEHOLDERS}</span>
                </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Steps</label>
                    <input
                        type="number"
                        value={comfy.steps ?? ''}
                        onChange={(e) => onNumberChange('steps', e.target.value)}
                        placeholder="20"
                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                    />
                </div>
                <div>
                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">CFG Scale</label>
                    <input
                        type="number"
                        step="0.1"
                        value={comfy.cfgScale ?? ''}
                        onChange={(e) => onNumberChange('cfgScale', e.target.value)}
                        placeholder="7"
                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                    />
                </div>
                <div>
                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Sampler</label>
                    <input
                        type="text"
                        value={comfy.sampler ?? ''}
                        onChange={(e) => onTextChange('sampler', e.target.value || undefined)}
                        placeholder="euler"
                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                    />
                </div>
                <div>
                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Scheduler</label>
                    <input
                        type="text"
                        value={comfy.scheduler ?? ''}
                        onChange={(e) => onTextChange('scheduler', e.target.value || undefined)}
                        placeholder="normal"
                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                    />
                </div>
                <div>
                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Denoise</label>
                    <input
                        type="number"
                        step="0.05"
                        min="0"
                        max="1"
                        value={comfy.denoisingStrength ?? ''}
                        onChange={(e) => onNumberChange('denoisingStrength', e.target.value)}
                        placeholder="1"
                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                    />
                </div>
            </div>
        </>
    );
}
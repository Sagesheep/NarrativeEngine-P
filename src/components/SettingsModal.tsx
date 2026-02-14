import { useState } from 'react';
import { X, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { testConnection } from '../services/chatEngine';

export function SettingsModal() {
    const { settings, updateSettings, settingsOpen, toggleSettings } = useAppStore();
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

    if (!settingsOpen) return null;

    const handleTest = async () => {
        setTesting(true);
        setTestResult(null);
        const result = await testConnection(settings);
        setTestResult(result);
        setTesting(false);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/70"
                onClick={toggleSettings}
            />

            {/* Panel */}
            <div className="relative bg-surface border border-border w-full max-w-md mx-4 p-6">
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

                <div className="space-y-4">
                    {/* Endpoint */}
                    <div>
                        <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">
                            API Endpoint
                        </label>
                        <input
                            type="text"
                            value={settings.endpoint}
                            onChange={(e) => updateSettings({ endpoint: e.target.value })}
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
                            value={settings.modelName}
                            onChange={(e) => updateSettings({ modelName: e.target.value })}
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
                            value={settings.apiKey}
                            onChange={(e) => updateSettings({ apiKey: e.target.value })}
                            placeholder="sk-..."
                            className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono"
                        />
                    </div>

                    {/* Context Limit */}
                    <div>
                        <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">
                            Context Limit: <span className="text-terminal">{settings.contextLimit}</span> tokens
                        </label>
                        <input
                            type="range"
                            min={1024}
                            max={32768}
                            step={512}
                            value={settings.contextLimit}
                            onChange={(e) => updateSettings({ contextLimit: Number(e.target.value) })}
                            className="w-full accent-terminal"
                        />
                        <div className="flex justify-between text-[10px] text-text-dim">
                            <span>1K</span>
                            <span>32K</span>
                        </div>
                    </div>
                </div>

                {/* Test Connection */}
                <div className="mt-6 pt-4 border-t border-border">
                    <button
                        onClick={handleTest}
                        disabled={testing}
                        className="w-full bg-void border border-terminal/40 hover:border-terminal text-terminal text-xs uppercase tracking-widest py-2.5 transition-all hover:glow-border disabled:opacity-50 flex items-center justify-center gap-2"
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

                    {testResult && (
                        <div
                            className={`mt-3 flex items-center gap-2 text-xs px-3 py-2 border ${testResult.ok
                                    ? 'border-terminal/30 text-terminal bg-terminal/5'
                                    : 'border-danger/30 text-danger bg-danger/5'
                                }`}
                        >
                            {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                            {testResult.detail}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

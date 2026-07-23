import { useAppStore } from '../../store/useAppStore';
import { VaultSection } from './VaultSection';
import { LanguageSection } from './LanguageSection';

export function GlobalSettingsTab() {
  const { settings, updateSettings } = useAppStore();

  return (
    <div className="mt-8 pt-6 border-t border-border space-y-4">
      <label className="text-text-dim text-xs uppercase tracking-widest font-bold block mb-2">Global Preferences</label>

      {/* WO-12.1 — 2-column grid on wide viewports (md+). Each preference is a
          card; compound sections (Rules RAG, Divergence, Auto-Trim, Auto-Archive)
          span both columns. Stacks to a single column on narrow/mobile. */}
      <div className="md:grid md:grid-cols-2 md:gap-4 space-y-4 md:space-y-0">

      {/* Interface Language */}
      <LanguageSection />

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

      {/* AI Tier */}
      <div className="bg-void p-3 border border-border rounded space-y-2">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            AI Tier
          </label>
          <p className="text-[9px] text-text-dim leading-tight">
            Lite: minimal background processing. Pro: agency + arc + scene-stakes (recommended). Max: all features including intro engine, reranker, deep scans.
          </p>
        </div>
        <div className="flex border border-border overflow-hidden rounded">
          {(['lite', 'pro', 'max'] as const).map(tier => (
            <button
              key={tier}
              onClick={() => updateSettings({ aiTier: tier })}
              className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider transition-colors focus:outline-none ${(settings.aiTier ?? 'pro') === tier
                ? 'bg-terminal text-void font-bold'
                : 'bg-void text-text-dim hover:text-text-primary'
              }`}
            >
              {tier}
            </button>
          ))}
        </div>
      </div>

      {/* Mature Mode */}
      <div className="flex items-center justify-between bg-void p-3 border border-border rounded">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            Mature Mode
          </label>
          <p className="text-[9px] text-text-dim max-w-[280px] leading-tight">
            Gates mature-tier NPC traits and wants (violence, dark themes). Disable for all-ages play.
          </p>
        </div>
        <button
          onClick={() => updateSettings({ matureMode: !settings.matureMode })}
          className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${settings.matureMode ? 'bg-terminal' : 'bg-border'}`}
        >
          <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.matureMode ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
        </button>
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

      {/* Deep Archive Search */}
      <div className="flex items-center justify-between bg-void p-3 border border-border rounded">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            Deep Archive Search
          </label>
          <p className="text-[9px] text-text-dim max-w-[240px] leading-tight">
            Enables AI-driven full-archive scan. Adds a "Deep Search" button to the toolbar.
            Requires a utility AI endpoint. Adds ~1-2 min per turn when used.
          </p>
        </div>
        <button
          onClick={() => updateSettings({ deepContextSearch: !settings.deepContextSearch })}
          className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${settings.deepContextSearch ? 'bg-amber-500' : 'bg-border'}`}
        >
          <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.deepContextSearch ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
        </button>
      </div>

      {/* Archive Agent Planner */}
      <div className="flex items-center justify-between bg-void p-3 border border-border rounded">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            Archive Agent Planner
          </label>
          <p className="text-[9px] text-text-dim max-w-[240px] leading-tight">
            Enables an intelligent utility AI planner to rank archive scenes based on structured scene events before recall.
            Requires a utility AI endpoint and structured events populated.
          </p>
        </div>
        <button
          onClick={() => updateSettings({ enableArchivePlanner: !settings.enableArchivePlanner })}
          className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${settings.enableArchivePlanner ? 'bg-terminal' : 'bg-border'}`}
        >
          <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.enableArchivePlanner ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
        </button>
      </div>

      {/* Retrieval algorithm (IDF+RRF vs classic) — kill-switch for the lore/rules ranker */}
      <div className="flex items-center justify-between bg-void p-3 border border-border rounded">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            IDF + RRF Retrieval
          </label>
          <p className="text-[9px] text-text-dim max-w-[240px] leading-tight">
            Ranks lore &amp; rules with IDF-weighted keywords fused with embeddings (Reciprocal Rank Fusion).
            Turn off to fall back to the classic flat-keyword scorer.
          </p>
        </div>
        <button
          onClick={() => updateSettings({ retrievalAlgorithm: (settings.retrievalAlgorithm ?? 'idf-rrf') === 'idf-rrf' ? 'classic' : 'idf-rrf' })}
          className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${(settings.retrievalAlgorithm ?? 'idf-rrf') === 'idf-rrf' ? 'bg-terminal' : 'bg-border'}`}
        >
          <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${(settings.retrievalAlgorithm ?? 'idf-rrf') === 'idf-rrf' ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
        </button>
      </div>

      {/* Indexing Speed — bulk-embed throughput vs CPU headroom during world imports */}
      <div className="bg-void p-3 border border-border rounded space-y-2">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            Indexing Speed
          </label>
          <p className="text-[9px] text-text-dim leading-tight">
            How aggressively to embed lore &amp; rules after a world import. Eco: gentle, keeps the app
            snappy. Balanced: default. Aggressive: finishes fastest but uses more CPU while it runs.
          </p>
        </div>
        <div className="flex border border-border overflow-hidden rounded">
          {(['eco', 'balanced', 'aggressive'] as const).map(speed => (
            <button
              key={speed}
              onClick={() => updateSettings({ indexingSpeed: speed })}
              className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider transition-colors focus:outline-none ${(settings.indexingSpeed ?? 'balanced') === speed
                ? 'bg-terminal text-void font-bold'
                : 'bg-void text-text-dim hover:text-text-primary'
              }`}
            >
              {speed}
            </button>
          ))}
        </div>
      </div>

      {/* Rules RAG Preferences */}
      <div className="md:col-span-2 bg-void p-3 border border-border rounded space-y-3">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            Rules RAG Preferences
          </label>
          <p className="text-[9px] text-text-dim leading-tight">
            Configure rules retrieval-augmented generation (RAG) settings, budget limits, and background extraction behavior.
          </p>
        </div>

        {/* Rules Context Budget Slider */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-text-dim uppercase tracking-wider">
              Rules Context Budget
            </label>
            <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-[10px]">
              {Math.round((settings.rulesBudgetPct ?? 0.10) * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.05}
            value={settings.rulesBudgetPct ?? 0.10}
            onChange={(e) => updateSettings({ rulesBudgetPct: parseFloat(e.target.value) })}
            className="w-full h-1.5 bg-border rounded-lg appearance-none cursor-pointer accent-terminal"
          />
          <div className="flex justify-between text-[8px] text-text-dim mt-0.5">
            <span>0%</span>
            <span>25%</span>
            <span>50%</span>
          </div>
        </div>

        {/* Auto-Generate Keywords Toggle */}
        <div className="flex items-center justify-between py-1.5 border-t border-border/30">
          <div>
            <label className="block text-[10px] text-text-primary uppercase tracking-wider font-bold mb-0.5">
              Auto-Generate Keywords
            </label>
            <p className="text-[9px] text-text-dim leading-tight">
              Automatically extract lookup keywords from rules using Utility AI.
            </p>
          </div>
          <button
            onClick={() => updateSettings({ autoGenerateRuleKeywords: !settings.autoGenerateRuleKeywords })}
            className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${settings.autoGenerateRuleKeywords ? 'bg-terminal' : 'bg-border'}`}
          >
            <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.autoGenerateRuleKeywords ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>

        {/* Utility AI Timeout Field */}
        <div className="pt-2 border-t border-border/30">
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-text-dim uppercase tracking-wider">
              Utility AI Timeout (Seconds)
            </label>
          </div>
          <input
            type="number"
            min={5}
            max={300}
            step={5}
            value={settings.utilityTimeoutSeconds ?? 45}
            onChange={(e) => {
              const v = parseInt(e.target.value);
              if (!isNaN(v) && v > 0) updateSettings({ utilityTimeoutSeconds: v });
            }}
            className="w-full h-7 bg-surface border border-border rounded px-2 text-xs text-text font-mono focus:outline-none focus:border-terminal"
          />
        </div>
      </div>

      {/* Divergence Register */}
      <div className="md:col-span-2 bg-void p-3 border border-border rounded space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
              Auto-Extract Divergences
            </label>
            <p className="text-[9px] text-text-dim max-w-[240px] leading-tight">
              Automatically extract campaign facts (canon changes, NPC states, obligations) from each turn.
              Importance gate: 7+ (use ⚡ for lower).
            </p>
          </div>
          <button
            onClick={() => updateSettings({ autoExtractDivergences: !settings.autoExtractDivergences })}
            className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${settings.autoExtractDivergences ? 'bg-amber-500' : 'bg-border'}`}
          >
            <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.autoExtractDivergences ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-text-dim uppercase tracking-wider">
              Divergence Token Budget
            </label>
          </div>
          <input
            type="number"
            min={500}
            step={250}
            value={settings.divergenceTokenBudget ?? 2000}
            onChange={(e) => {
              const v = parseInt(e.target.value);
              if (!isNaN(v) && v > 0) updateSettings({ divergenceTokenBudget: v });
            }}
            className="w-full h-7 bg-surface border border-border rounded px-2 text-xs text-text font-mono focus:outline-none focus:border-amber-500"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-text-dim uppercase tracking-wider">
              Scan Budget (per batch)
            </label>
            <span className="text-amber-500 font-bold font-mono bg-amber-500/10 px-2 py-0.5 rounded text-[10px]">
              {(() => {
                const v = settings.divergenceScanBudget ?? 0;
                if (v === 0) {
                  const ctx = settings.contextLimit ?? 4096;
                  return `Auto (${Math.round(ctx * 0.75)})`;
                }
                return v;
              })()}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={settings.contextLimit ?? 4096}
            step={500}
            value={settings.divergenceScanBudget ?? 0}
            onChange={(e) => updateSettings({ divergenceScanBudget: parseInt(e.target.value) })}
            className="w-full h-1.5 bg-border rounded-lg appearance-none cursor-pointer accent-amber-500"
          />
          <div className="flex justify-between text-[8px] text-text-dim mt-0.5">
            <span>Auto (0)</span>
            <span>{settings.contextLimit ?? 4096}</span>
          </div>
          <p className="text-[8px] text-text-dim mt-1 leading-tight">
            Max tokens per batch for scanning chapters. 0 = auto (75% of context limit).
          </p>
        </div>
      </div>

      {/* Auto-Trim (Auto-Condense) */}
      <div className="md:col-span-2 bg-void p-3 border border-border rounded space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
              Auto-Trim
            </label>
            <p className="text-[9px] text-text-dim max-w-[240px] leading-tight">
              Automatically condense history when it exceeds a token budget. Prevents context overflow without manual intervention.
            </p>
          </div>
          <button
            onClick={() => updateSettings({ autoCondenseEnabled: !(settings.autoCondenseEnabled ?? true) })}
            className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${(settings.autoCondenseEnabled ?? true) ? 'bg-terminal' : 'bg-border'}`}
          >
            <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-surface transition-transform ${(settings.autoCondenseEnabled ?? true) ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-text-dim uppercase tracking-wider">
              Aggressiveness
            </label>
            <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-[10px]">
              {(() => {
                const a = settings.condenseAggressiveness ?? 'smart';
                if (a === 'tight') return 'Tight (50%)';
                if (a === 'deep') return 'Deep (90%)';
                return 'Smart (75%)';
              })()}
            </span>
          </div>
          <div className="flex border border-border overflow-hidden rounded">
            {(['tight', 'smart', 'deep'] as const).map(level => (
              <button
                key={level}
                onClick={() => updateSettings({ condenseAggressiveness: level })}
                className={`flex-1 px-3 py-2 text-[10px] uppercase tracking-wider transition-colors focus:outline-none ${(settings.condenseAggressiveness ?? 'smart') === level
                  ? 'bg-terminal text-void font-bold'
                  : 'bg-void text-text-dim hover:text-text-primary'
                }`}
              >
                {level === 'tight' ? 'Tight' : level === 'smart' ? 'Smart' : 'Deep'}
              </button>
            ))}
          </div>
          <p className="text-[8px] text-text-dim mt-1.5 leading-tight">
            {(() => {
              const a = settings.condenseAggressiveness ?? 'smart';
              if (a === 'tight') return 'Condenses early at 50% budget — smaller context, more frequent compression.';
              if (a === 'deep') return 'Condenses only at 90% budget — maximum context before compression.';
              return 'Balanced — condenses at 75% budget threshold.';
            })()}
          </p>
        </div>
      </div>

      {/* Auto-Archive Stale NPCs */}
      <div className="md:col-span-2 bg-void p-3 border border-border rounded space-y-2">
        <div>
          <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
            Auto-Archive Stale NPCs
          </label>
          <p className="text-[9px] text-text-dim max-w-[240px] leading-tight">
            Archive NPCs not mentioned for N turns. 0 = never auto-archive.
          </p>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-text-dim uppercase tracking-wider">
              Turns before archive
            </label>
            <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-[10px]">
              {(() => {
                const v = settings.autoArchiveStaleNPCsTurns ?? 0;
                return v === 0 ? 'Off' : `${v} turns`;
              })()}
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="50"
            step="5"
            value={settings.autoArchiveStaleNPCsTurns ?? 0}
            onChange={(e) => updateSettings({ autoArchiveStaleNPCsTurns: parseInt(e.target.value, 10) })}
            className="w-full h-1.5 bg-border rounded-lg appearance-none cursor-pointer accent-terminal"
          />
          <div className="flex justify-between text-[8px] text-text-dim mt-0.5">
            <span>Off (0)</span>
            <span>25</span>
            <span>50</span>
          </div>
        </div>
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
            onClick={() => updateSettings({ theme: 'system' })}
            className={`px-4 py-1.5 text-[10px] uppercase tracking-wider border-l border-border transition-colors focus:outline-none ${settings.theme === 'system'
              ? 'bg-terminal text-surface font-bold'
              : 'bg-void text-text-dim hover:text-text-primary'
              }`}
          >
            ⚙ System
          </button>
          <button
            onClick={() => updateSettings({ theme: 'dark' })}
            className={`px-4 py-1.5 text-[10px] uppercase tracking-wider border-l border-border focus:outline-none ${settings.theme === 'dark'
              ? 'bg-terminal text-surface font-bold'
              : 'bg-void text-text-dim hover:text-text-primary'
              }`}
          >
            ☽ Dark
          </button>
        </div>
      </div>

      {/* UI Scale */}
      <div className="flex flex-col bg-void p-3 border border-border rounded space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold">UI Scale</label>
          <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-[10px]">
            {Math.round((settings.uiScale ?? 1) * 100)}%
          </span>
        </div>
        <p className="text-[9px] text-text-dim leading-tight">Global zoom. 100% is the default. Changes apply immediately.</p>
        <div className="flex flex-wrap gap-1.5">
          {[0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3].map(v => (
            <button
              key={v}
              onClick={() => updateSettings({ uiScale: v })}
              className={`px-2 py-1 text-[10px] uppercase font-mono border rounded transition-colors focus:outline-none ${Math.round((settings.uiScale ?? 1) * 100) === Math.round(v * 100) ? 'bg-terminal text-void border-terminal' : 'bg-surface border-border text-text-dim hover:text-text-primary hover:border-text-dim'}`}
            >
              {Math.round(v * 100)}%
            </button>
          ))}
        </div>
      </div>

      {/* Image Style Prompt */}
      <div className="flex flex-col bg-void p-3 border border-border rounded">
        <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">Image Style Prompt</label>
        <p className="text-[9px] text-text-dim mb-2 leading-tight">Prepended to every illustration request. Leave empty for the default style scaffold.</p>
        <input
          type="text"
          value={settings.imageStylePrompt || ''}
          onChange={(e) => updateSettings({ imageStylePrompt: e.target.value })}
          placeholder="e.g. oil painting, fantasy art, dark atmosphere"
          className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 focus:border-terminal focus:outline-none"
        />
      </div>

      {/* Image Negative Prompt */}
      <div className="flex flex-col bg-void p-3 border border-border rounded">
        <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">Image Negative Prompt</label>
        <p className="text-[9px] text-text-dim mb-2 leading-tight">Elements to exclude from generated images. Only supported by some models (e.g. DALL-E 2, Stable Diffusion).</p>
        <input
          type="text"
          value={settings.imageNegativePrompt || ''}
          onChange={(e) => updateSettings({ imageNegativePrompt: e.target.value })}
          placeholder="e.g. text, watermark, blurry, deformed"
          className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 focus:border-terminal focus:outline-none"
        />
      </div>

      {/* Vault Export/Import */}
      <div className="md:col-span-2">
        <VaultSection />
      </div>
      </div>
    </div>
  );
}

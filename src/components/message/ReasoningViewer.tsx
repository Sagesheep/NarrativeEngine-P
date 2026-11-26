import { Loader2 } from 'lucide-react';
import type { RelationshipMemoryFault, RelationshipMemoryRecord, RelationshipStance } from '../../types';
import { RelationshipMemoryEditor } from '../character/RelationshipMemoryEditor';

/**
 * Reasoning accordion — collapsible "Cognitive Process" block showing the
 * model's <think> content on GM messages when Show Reasoning is enabled.
 */
export function ReasoningViewer({ thinkingBlock, spinning, relationshipMemories = [], relationshipMemoryFaults = [], relationshipStances = [] }: { thinkingBlock: string; spinning: boolean; relationshipMemories?: RelationshipMemoryRecord[]; relationshipMemoryFaults?: RelationshipMemoryFault[]; relationshipStances?: RelationshipStance[] }) {
    return (
        <details className="mb-3 bg-void-darker border border-terminal/20 rounded overflow-hidden">
            <summary className="cursor-pointer p-2 text-[10px] text-terminal/60 hover:text-terminal transition-colors select-none uppercase tracking-widest flex items-center gap-2 bg-terminal/5">
                <Loader2 size={10} className={spinning ? "animate-spin" : ""} />
                Cognitive Process
            </summary>
            {thinkingBlock && (
                <div className="p-3 text-[11px] text-text-dim/80 italic border-t border-terminal/10 max-h-[300px] overflow-y-auto whitespace-pre-wrap leading-relaxed">
                    {thinkingBlock}
                </div>
            )}
            {(relationshipMemories.length > 0 || relationshipMemoryFaults.length > 0) && (
                <div className="border-t border-terminal/10 p-3 text-[10px] text-text-dim/80 space-y-2">
                    <div className="uppercase tracking-widest text-terminal/60">Relationship memory</div>
                    <RelationshipMemoryEditor records={relationshipMemories} allowAdd={false} compact title="Recorded memories" />
                    {relationshipMemoryFaults.map((fault, index) => <div key={fault.sceneId + index} className="text-ember">Fault: {fault.message}</div>)}
                </div>
            )}
            {relationshipStances.length > 0 && (
                <div className="border-t border-terminal/10 p-3 text-[10px] text-text-dim/80 space-y-3 not-italic">
                    <div className="uppercase tracking-widest text-terminal/60">NPC stance reasoning</div>
                    {relationshipStances.map((entry) => (
                        <div key={entry.npcId} className="border border-terminal/10 rounded p-2 space-y-2">
                            <div className="text-terminal/80 uppercase tracking-wider">
                                STANCE — {entry.npcName} · scene {entry.sceneId} · {entry.targetName}
                            </div>
                            <div className="text-text-dim/70">
                                tier: <span className="text-ice">{entry.tier}</span>
                                {' · '}clashes: {entry.clashCount}
                                {' · '}pins: {entry.pinCount}
                                {entry.forcedDeep ? ' · carried floor' : ''}
                                {' · '}score: {Number.isFinite(entry.tierScore) ? entry.tierScore.toFixed(2) : '∞'}
                            </div>
                            <div className="text-text-dim/70">status: {entry.statuses} | non-negotiables: {entry.nonNegotiables}</div>
                            {entry.tier === 'deep' && entry.topRecords.length > 0 && (
                                <div>
                                    <div className="uppercase tracking-wider text-terminal/50 mb-1">Top records</div>
                                    {entry.topRecords.map((record, index) => (
                                        <div key={record.sceneId + index} className="text-text-dim/70">
                                            {record.line} <span className="text-ice/70">({record.injectionScore.toFixed(2)})</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {entry.stance && (
                                <div className="space-y-1">
                                    <div><span className="text-terminal/60">wants now:</span> {entry.stance.wantsNow}</div>
                                    <div><span className="text-terminal/60">hiding:</span> {entry.stance.hiding}</div>
                                    <div><span className="text-terminal/60">won't:</span> {entry.stance.wont}</div>
                                    <div><span className="text-terminal/60">in tension:</span> {entry.stance.inTension.join(' · ') || 'none'}</div>
                                    <div><span className="text-terminal/60">believes (may be wrong):</span> {entry.stance.believes}</div>
                                    <div><span className="text-terminal/60">manner:</span> {entry.stance.manner}</div>
                                    <div><span className="text-terminal/60">strain:</span> {entry.stance.strain}</div>
                                    <div><span className="text-terminal/60">express as behavior:</span> she never names the contradiction</div>
                                    <div className="pt-1"><span className="text-terminal/60">considered:</span> {entry.stance.considered.join(' · ') || 'none'}</div>
                                    <div><span className="text-terminal/60">read room as:</span> {entry.stance.readRoomAs}</div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </details>
    );
}

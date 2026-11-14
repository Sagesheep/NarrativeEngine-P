import { useMemo } from 'react';
import { previewAbility } from '@narrative/engine';
import type { AbilityPreview, PreviewUnit } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import type { GlyphAbility } from '../../types';
import { sideColor } from '../combat/combatVisuals';

const CELL = 24;

function Unit({ unit, hit }: { unit: PreviewUnit; hit: boolean }) {
    const cx = unit.position.x * CELL + CELL / 2;
    const cy = unit.position.y * CELL + CELL / 2;
    const fill = sideColor(unit.side);
    const r = CELL * 0.32;
    return (
        <g data-testid="preview-unit" data-id={unit.id} data-side={unit.side}>
            {unit.side === 'enemy' && <polygon points={`${cx},${cy - r - 1} ${cx + r + 1},${cy} ${cx},${cy + r + 1} ${cx - r - 1},${cy}`} style={{ fill }} />}
            {unit.side === 'ally' && <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={3} style={{ fill }} />}
            {unit.side === 'player' && (
                <>
                    <circle cx={cx} cy={cy} r={r + 1} style={{ fill }} />
                    <circle cx={cx} cy={cy} r={r * 0.4} style={{ fill: 'var(--combat-token-text)' }} />
                </>
            )}
            {hit && <circle data-testid="preview-hit" data-id={unit.id} cx={cx} cy={cy} r={CELL * 0.46} fill="none" strokeWidth={2.5} style={{ stroke: 'var(--combat-cursor)' }} />}
        </g>
    );
}

export function TargetPreview({ ability }: { ability: GlyphAbility | null }) {
    const { t } = useTranslation();
    const preview = useMemo<AbilityPreview | null>(() => (ability ? previewAbility(ability) : null), [ability]);
    if (!preview) {
        return (
            <div data-testid="target-preview" className="rounded-lg border border-dashed border-border p-4 text-xs text-text-dim leading-relaxed">
                {t('spellbook.preview.waiting')}
            </div>
        );
    }
    const { result } = preview;
    const hits = new Set(result.targetIds);
    const enemies = preview.units.filter(u => hits.has(u.id) && u.side === 'enemy').length;
    const friends = preview.units.filter(u => hits.has(u.id) && u.side !== 'enemy').length;
    const caption = result.ok ? t('spellbook.preview.hits', { enemies, friends }) : t('spellbook.preview.none', { reason: result.reason ?? '' });
    const cells: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < preview.height; y++) for (let x = 0; x < preview.width; x++) cells.push({ x, y });
    const marked = result.ok ? result.tiles : [];
    const barriers = result.ok ? result.barrierTiles ?? [] : [];
    return (
        <div data-testid="target-preview" className="flex flex-col gap-2">
            <svg
                viewBox={`0 0 ${preview.width * CELL} ${preview.height * CELL}`}
                role="img"
                aria-label={`${t('spellbook.preview')}: ${caption}`}
                className="w-full max-w-[15rem] rounded-lg border border-border"
                style={{ background: 'var(--combat-board-bg)' }}
            >
                {cells.map(c => (
                    <rect key={`${c.x},${c.y}`} x={c.x * CELL} y={c.y * CELL} width={CELL} height={CELL} style={{ fill: 'var(--combat-floor)', stroke: 'var(--combat-grid-line)' }} strokeWidth={1} />
                ))}
                {marked.map(p => (
                    <rect key={`m${p.x},${p.y}`} data-testid="preview-tile" data-x={p.x} data-y={p.y} x={p.x * CELL} y={p.y * CELL} width={CELL} height={CELL} style={{ fill: 'var(--combat-target)' }} />
                ))}
                {barriers.map(p => (
                    <rect key={`b${p.x},${p.y}`} data-testid="preview-barrier" x={p.x * CELL + 2} y={p.y * CELL + 2} width={CELL - 4} height={CELL - 4} fill="none" strokeWidth={2} strokeDasharray="4 3" style={{ stroke: 'var(--combat-wall)' }} />
                ))}
                {result.ok && result.destination && (
                    <rect data-testid="preview-destination" x={result.destination.x * CELL + 2} y={result.destination.y * CELL + 2} width={CELL - 4} height={CELL - 4} rx={4} fill="none" strokeWidth={2} style={{ stroke: 'var(--combat-path)' }} />
                )}
                {result.ok && result.summonAt && (
                    <rect data-testid="preview-summon" x={result.summonAt.x * CELL + 4} y={result.summonAt.y * CELL + 4} width={CELL - 8} height={CELL - 8} rx={6} fill="none" strokeWidth={2} strokeDasharray="3 2" style={{ stroke: 'var(--combat-party)' }} />
                )}
                {preview.units.map(u => <Unit key={u.id} unit={u} hit={hits.has(u.id)} />)}
            </svg>
            <p data-testid="preview-caption" className="text-xs text-text-dim leading-relaxed">{caption}</p>
            <p className="text-xs text-text-dim leading-relaxed">{t('spellbook.preview.legend')}</p>
        </div>
    );
}

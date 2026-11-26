import { X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

/**
 * Beta UI — the one armed row (audit F8).
 *
 * Five features in this app "arm" and then fire on your next send: deep search,
 * a manual dice roll, a loot drop, a one-shot event, and an absolute command.
 * Each one announced itself its own way — an amber border and a relabelled
 * button, a pulsing border, a count baked into a label, a bespoke gold
 * two-segment control — so there was no single place to look to answer the only
 * question that matters before pressing Enter: *what is about to happen?*
 *
 * This is that place. One row, one chip per armed modifier, one `×` to cancel.
 * The buttons in the strip keep their own on/off state; this row is purely a
 * readout plus a disarm, so nothing about how arming WORKS changes — which is
 * why it can be additive and gated rather than a rewrite of five controls.
 *
 * Renders `null` when nothing is armed, so the composer gains no height at rest.
 *
 * NOTE travel is deliberately absent: an in-progress journey already has its own
 * dedicated chip (`AbandonJourneyChip`) inside the action strip, and duplicating
 * it here would put the same state in two places — the exact problem this row
 * exists to end.
 */
export function BetaArmedRow() {
    const deepArmed = useAppStore(s => s.deepArmed);
    const setDeepArmed = useAppStore(s => s.setDeepArmed);
    const armedRoll = useAppStore(s => s.armedRoll);
    const setArmedRoll = useAppStore(s => s.setArmedRoll);
    const armedLoot = useAppStore(s => s.armedLoot);
    const clearArmedLoot = useAppStore(s => s.clearArmedLoot);
    const armedOneShot = useAppStore(s => s.armedOneShot);
    const setArmedOneShot = useAppStore(s => s.setArmedOneShot);
    const armedAbsoluteCommand = useAppStore(s => s.armedAbsoluteCommand);
    const setArmedAbsoluteCommand = useAppStore(s => s.setArmedAbsoluteCommand);

    const chips: { key: string; label: string; detail?: string; onClear: () => void }[] = [];

    if (deepArmed) {
        chips.push({ key: 'deep', label: 'Deep search', onClear: () => setDeepArmed(false) });
    }
    if (armedRoll) {
        // `armedRoll` is either the current object shape or a legacy string.
        const detail = typeof armedRoll === 'string' ? armedRoll : armedRoll.dieTypeId;
        chips.push({ key: 'dice', label: 'Dice', detail, onClear: () => setArmedRoll(null) });
    }
    if (armedLoot) {
        chips.push({
            key: 'loot',
            label: 'Loot',
            detail: `${armedLoot.rolls} roll${armedLoot.rolls === 1 ? '' : 's'}`,
            onClear: () => clearArmedLoot(),
        });
    }
    if (armedOneShot) {
        chips.push({
            key: 'oneshot',
            label: 'Event',
            detail: String(armedOneShot).replace(/[-_]/g, ' '),
            onClear: () => setArmedOneShot(null),
        });
    }
    if (armedAbsoluteCommand) {
        const text = armedAbsoluteCommand.trim();
        chips.push({
            key: 'absolute',
            label: 'Absolute command',
            detail: text.length > 46 ? `${text.slice(0, 46)}…` : text,
            onClear: () => setArmedAbsoluteCommand(null),
        });
    }

    if (chips.length === 0) return null;

    return (
        <div data-ui="armed-row" aria-live="polite">
            <span data-ui="armed-lead">Armed</span>
            {chips.map(chip => (
                <span key={chip.key} data-ui="armed-chip">
                    <b>{chip.label}</b>
                    {chip.detail ? <i>{chip.detail}</i> : null}
                    <button
                        type="button"
                        onClick={chip.onClear}
                        title={`Cancel ${chip.label.toLowerCase()}`}
                        aria-label={`Cancel ${chip.label.toLowerCase()}`}
                    >
                        <X size={11} strokeWidth={2.6} />
                    </button>
                </span>
            ))}
        </div>
    );
}

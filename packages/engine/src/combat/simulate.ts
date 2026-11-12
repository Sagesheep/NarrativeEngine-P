import { buildPcCombatant } from './pc';
import { applyAction, chooseEngineTurn, createCombat, currentActorId, runEngineTurns } from './resolve';
import type { CombatantSpec, CombatState, MapSpec, PcCombatantInput } from './types';

export type SimulationResult = {
    fights: number;
    wins: number;
    winRate: number;
    meanRounds: number;
};

export type SimulationOptions = {
    baseSeed?: number;
    jitterRange?: number;
    map?: MapSpec;
};

function playerTurn(state: CombatState): CombatState {
    const actorId = currentActorId(state);
    if (!actorId) return state;
    const startCount = state.turnCount;
    let current = state;
    for (let i = 0; i < 20; i++) {
        if (current.outcome || currentActorId(current) !== actorId || current.turnCount !== startCount) break;
        const choice = chooseEngineTurn(current, actorId);
        const action = choice.actions[0] ?? { type: 'end_turn', actorId };
        const result = applyAction(choice.state, action);
        current = result.events.some(e => e.type === 'rejected')
            ? applyAction(choice.state, { type: 'end_turn', actorId }).state
            : result.state;
    }
    return current;
}

export function simulateFights(pc: PcCombatantInput, enemies: CombatantSpec[], fights: number, options: SimulationOptions = {}): SimulationResult {
    const baseSeed = options.baseSeed ?? 1;
    let wins = 0;
    let rounds = 0;
    for (let i = 0; i < fights; i++) {
        const seed = baseSeed + i * 7919;
        const started = createCombat(
            { id: `sim${i}`, combatants: enemies, jitterRange: options.jitterRange, ...(options.map ? { map: options.map } : {}), mapSeed: seed * 31 + 17 },
            buildPcCombatant(pc),
            seed,
        );
        let state = runEngineTurns(started.state).state;
        for (let guard = 0; guard < 1000 && !state.outcome; guard++) {
            state = playerTurn(state);
            state = runEngineTurns(state).state;
        }
        if (state.outcome === 'victory') wins += 1;
        rounds += state.round;
    }
    return { fights, wins, winRate: fights > 0 ? wins / fights : 0, meanRounds: fights > 0 ? rounds / fights : 0 };
}

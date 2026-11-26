import { describe, it, expect } from 'vitest';
import {
    BUILTIN_IDS,
    SUPPRESSIBLE_BUILTIN_IDS,
    createFinalUserRegistry,
} from '../builtins';
import { assembleContributions } from '../assemble';
import { PROTECTED_SUPPRESSION_IDS } from '../../../mods/modTypes';
import type { AppSettings, RelationshipStance } from '../../../../types';

/**
 * WO-4 §4 — the relationship contribution is suppressible; `volatile.block`
 * stays protected. This is the prerequisite for v3 to replace the flat scalar
 * with the stance without the two contradicting each other in the same prompt.
 */
const baseSettings = { debugMode: true, contextLimit: 8192 } as unknown as AppSettings;

describe('WO-4 §4 — the on-stage relations contribution is suppressible', () => {
    it('npc.relations is in the published SUPPRESSIBLE_BUILTIN_IDS set', () => {
        expect(SUPPRESSIBLE_BUILTIN_IDS).toContain(BUILTIN_IDS.relations);
    });

    it('npc.relations is NOT in PROTECTED_SUPPRESSION_IDS (it is not structural)', () => {
        expect(PROTECTED_SUPPRESSION_IDS).not.toContain(BUILTIN_IDS.relations);
    });

    it('volatile.block stays protected (still in PROTECTED_SUPPRESSION_IDS)', () => {
        expect(PROTECTED_SUPPRESSION_IDS).toContain(BUILTIN_IDS.volatileBlock);
    });

    it('volatile.block is NOT suppressible (still structural)', () => {
        expect(SUPPRESSIBLE_BUILTIN_IDS).not.toContain(BUILTIN_IDS.volatileBlock);
    });

    it('the relations block renders when enabled and non-empty', () => {
        const registry = createFinalUserRegistry();
        const assembled = assembleContributions(registry.collect({
            settings: baseSettings,
            userMessage: 'I greet Elara.',
            volatileBlock: '[WORLD STATE]\nThe tavern is emptying.',
            relationsBlock: '[ON-STAGE RELATIONS]\nAlden→Bram: +2',
        }));
        expect(assembled.text).toContain('[ON-STAGE RELATIONS]');
        expect(assembled.text).toContain('Alden→Bram: +2');
        expect(assembled.included).toContain(BUILTIN_IDS.relations);
    });

    it('the relations block is dropped when empty (byte-identical to no-relations case)', () => {
        const registry = createFinalUserRegistry();
        const assembled = assembleContributions(registry.collect({
            settings: baseSettings,
            userMessage: 'I greet Elara.',
            volatileBlock: '[WORLD STATE]\nThe tavern is emptying.',
            relationsBlock: '',
        }));
        expect(assembled.text).not.toContain('[ON-STAGE RELATIONS]');
        expect(assembled.included).not.toContain(BUILTIN_IDS.relations);
    });

    it('the relations block can be suppressed by a mod (suppressed set reports it)', () => {
        const registry = createFinalUserRegistry();
        const specs = registry.collect({
            settings: baseSettings,
            userMessage: 'I greet Elara.',
            volatileBlock: '[WORLD STATE]\nThe tavern is emptying.',
            relationsBlock: '[ON-STAGE RELATIONS]\nAlden→Bram: +2',
        });
        // A mod that suppresses npc.relations (host-supplied suppression channel).
        const assembled = assembleContributions(specs, {
            suppress: [{ id: BUILTIN_IDS.relations, by: 'mod.test' }],
        });
        expect(assembled.text).not.toContain('[ON-STAGE RELATIONS]');
        expect(assembled.suppressed).toContainEqual({ id: BUILTIN_IDS.relations, by: 'mod.test' });
    });

    it('the relations block can be switched off via the enablement predicate', () => {
        const registry = createFinalUserRegistry();
        const specs = registry.collect(
            {
                settings: baseSettings,
                userMessage: 'I greet Elara.',
                volatileBlock: '[WORLD STATE]\nThe tavern is emptying.',
                relationsBlock: '[ON-STAGE RELATIONS]\nAlden→Bram: +2',
            },
            { isEnabled: (id) => id !== BUILTIN_IDS.relations },
        );
        const assembled = assembleContributions(specs);
        expect(assembled.text).not.toContain('[ON-STAGE RELATIONS]');
        expect(assembled.included).not.toContain(BUILTIN_IDS.relations);
    });
});

describe('WO-5 — the stance contribution replaces scalar relationship context', () => {
    const stance: RelationshipStance = {
        npcId: 'n1',
        npcName: 'Alden',
        targetName: 'MC',
        sceneId: '007',
        sceneKey: 'scene',
        statuses: 'wounded',
        nonNegotiables: 'will not kneel',
        tier: 'cheap',
        tierScore: 1,
        clashCount: 0,
        pinCount: 1,
        forcedDeep: false,
        topRecords: [{
            sceneId: '006', subject: 'n1', target: 'MC', mood: 'hostile', impact: 'formative',
            event: 'MC refused the oath', outcome: 'Alden left the table', source: 'recorded',
            injectionScore: 2, line: '#006 MC refused the oath — Alden left the table [hostile, formative; weight 2.00]',
        }],
    };

    it('renders canonical stance memory lines and omits relation arrows when the stance is present', () => {
        const registry = createFinalUserRegistry();
        const assembled = assembleContributions(registry.collect({
            settings: baseSettings,
            userMessage: 'I greet Alden.',
            volatileBlock: '[WORLD STATE]',
            relationsBlock: '[ON-STAGE RELATIONS]\nAlden→Bram: +2',
            relationshipStances: [stance],
        }));
        expect(assembled.text).toContain('[NPC STANCES]');
        expect(assembled.text).toContain(stance.topRecords[0].line);
        expect(assembled.text).not.toContain('[ON-STAGE RELATIONS]');
        expect(assembled.suppressed).toContainEqual({ id: BUILTIN_IDS.relations, by: BUILTIN_IDS.stance });
    });
});

import { useCallback } from 'react';
import type { GlyphRef, PlacementReason } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import { glyphLabelKey } from '../character/tabs/glyphLabels';

export function useReasonText(): (reason: PlacementReason) => string {
    const { t } = useTranslation();
    return useCallback((reason: PlacementReason): string => {
        const name = (g: GlyphRef) => t(glyphLabelKey(g));
        switch (reason.code) {
            case 'wrong-socket': return t('spellbook.reason.wrongSocket', { kind: t(`spellbook.kind.${reason.expects}`) });
            case 'needs-form': return t('spellbook.reason.needsForm');
            case 'form-cannot-carry': return t('spellbook.reason.formCannotCarry', { forms: reason.forms.map(id => name({ kind: 'form', id })).join(', ') });
            case 'already-used': return t('spellbook.reason.alreadyUsed');
            case 'must-be-alone': return t('spellbook.reason.mustBeAlone');
            case 'solo-present': return t('spellbook.reason.soloPresent', { effect: name({ kind: 'effect', id: reason.with }) });
            case 'swap-conflict': return t('spellbook.reason.swapConflict');
            case 'barrier-widen': return t('spellbook.reason.barrierWiden');
            case 'summons-off': return t('spellbook.reason.summonsOff');
            case 'not-accepted': return t('spellbook.reason.notAccepted', { glyph: name(reason.by) });
            case 'no-owner': return t('spellbook.reason.noOwner', { glyphs: reason.accepted.map(name).join(', ') });
            case 'augment-limit': return t('spellbook.reason.augmentLimit', { max: reason.max });
            case 'effects-full': return t('spellbook.reason.effectsFull', { max: reason.max });
            case 'chain-full': return t('spellbook.reason.chainFull', { limit: reason.limit });
        }
    }, [t]);
}

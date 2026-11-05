import { useState } from 'react';
import type { Campaign } from '../types';
import type { CampaignCopyOptions } from '../store/campaignStore';
import { useTranslation } from '../i18n/useTranslation';
import { Backdrop } from './primitives/Backdrop';
import { GhostBtn, PrimaryBtn } from './primitives/Buttons';

const headingStyle: React.CSSProperties = {
    fontFamily: "'Cinzel', serif", fontSize: 14, fontWeight: 600,
    color: 'var(--color-text-primary)', margin: '0 0 6px',
};
const bodyStyle: React.CSSProperties = {
    fontFamily: "'EB Garamond', serif", fontSize: 14, lineHeight: 1.5,
    color: 'var(--color-text-primary)', opacity: 0.75, margin: '0 0 12px',
};
const sectionStyle: React.CSSProperties = {
    padding: 14, borderRadius: 4, marginTop: 12,
    border: '1px solid color-mix(in srgb, var(--color-terminal) 20%, transparent)',
};
const checkboxStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer',
    fontFamily: "'EB Garamond', serif", fontSize: 14, color: 'var(--color-text-primary)',
};
const actionRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end', marginTop: 4 };

export function CampaignCopyDialog({ campaign, onCopy, onClose }: {
    campaign: Campaign;
    onCopy: (options: CampaignCopyOptions) => Promise<void>;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [keepNpcs, setKeepNpcs] = useState(true);
    const [keepCharacter, setKeepCharacter] = useState(false);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);

    const run = async (options: CampaignCopyOptions) => {
        setBusy(true);
        setFailed(false);
        try {
            await onCopy(options);
        } catch (err) {
            console.error('[Copy]', err);
            setFailed(true);
            setBusy(false);
        }
    };

    return (
        <Backdrop onClick={() => { if (!busy) onClose(); }}>
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t('hub.copy.title', { name: campaign.name })}
                onClick={e => e.stopPropagation()}
                style={{
                    background: 'var(--color-surface)', borderRadius: 6, padding: 24,
                    border: '1px solid color-mix(in srgb, var(--color-terminal) 30%, transparent)',
                    maxWidth: 440, width: '100%', maxHeight: '100%', overflowY: 'auto',
                }}
            >
                <h2 style={{ ...headingStyle, fontSize: 16, margin: 0 }}>
                    {t('hub.copy.title', { name: campaign.name })}
                </h2>

                <section style={sectionStyle}>
                    <h3 style={headingStyle}>{t('hub.copy.clean.title')}</h3>
                    <p style={bodyStyle}>{t('hub.copy.clean.body')}</p>
                    <label style={checkboxStyle}>
                        <input type="checkbox" checked={keepNpcs} onChange={e => setKeepNpcs(e.target.checked)} />
                        {t('hub.copy.clean.keepNpcs')}
                    </label>
                    <label style={checkboxStyle}>
                        <input type="checkbox" checked={keepCharacter} onChange={e => setKeepCharacter(e.target.checked)} />
                        {t('hub.copy.clean.keepCharacter')}
                    </label>
                    <div style={actionRowStyle}>
                        <PrimaryBtn disabled={busy} onClick={() => run({ mode: 'clean', keepNpcs, keepCharacter })}>
                            {t('hub.copy.confirmClean')}
                        </PrimaryBtn>
                    </div>
                </section>

                <section style={sectionStyle}>
                    <h3 style={headingStyle}>{t('hub.copy.full.title')}</h3>
                    <p style={bodyStyle}>{t('hub.copy.full.body')}</p>
                    <div style={actionRowStyle}>
                        <PrimaryBtn disabled={busy} onClick={() => run({ mode: 'full' })}>
                            {t('hub.copy.confirmFull')}
                        </PrimaryBtn>
                    </div>
                </section>

                {failed && (
                    <p role="alert" style={{ ...bodyStyle, color: 'var(--color-danger)', opacity: 1, margin: '12px 0 0' }}>
                        {t('hub.copy.failed')}
                    </p>
                )}

                <div style={{ ...actionRowStyle, marginTop: 16 }}>
                    <GhostBtn onClick={() => { if (!busy) onClose(); }}>{t('hub.copy.cancel')}</GhostBtn>
                </div>
            </div>
        </Backdrop>
    );
}

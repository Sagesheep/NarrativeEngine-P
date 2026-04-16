export function GhostBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
    return (
        <button onClick={onClick} style={{
            padding: '8px 18px', fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em',
            color: 'rgba(107,107,107,0.7)', background: 'transparent',
            border: '1px solid rgba(106,159,212,0.20)', borderRadius: 3,
            cursor: 'pointer', transition: 'all 0.2s',
        }}>
            {children}
        </button>
    );
}

export function PrimaryBtn({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
    return (
        <button onClick={onClick} disabled={disabled} style={{
            padding: '8px 20px', fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.15em',
            textTransform: 'uppercase',
            color: disabled ? 'rgba(106,159,212,0.40)' : '#FFFFFF',
            background: disabled ? 'transparent' : 'var(--color-terminal)',
            border: `1px solid ${disabled ? 'rgba(106,159,212,0.20)' : 'var(--color-terminal)'}`,
            borderRadius: 3, cursor: disabled ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s', fontWeight: 600,
        }}>
            {children}
        </button>
    );
}

export function DangerBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
    return (
        <button onClick={onClick} style={{
            padding: '8px 20px', fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.15em',
            textTransform: 'uppercase',
            color: '#FFFFFF', background: 'var(--color-danger)',
            border: '1px solid var(--color-danger)',
            borderRadius: 3, cursor: 'pointer',
            transition: 'all 0.2s', fontWeight: 600,
        }}>
            {children}
        </button>
    );
}

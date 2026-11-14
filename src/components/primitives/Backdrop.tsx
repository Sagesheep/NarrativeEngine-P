export function Backdrop({ onClick, children, layer = 50 }: { onClick: () => void; children: React.ReactNode; layer?: number }) {
    return (
        <div data-motion="overlay" onClick={onClick} style={{
            position: 'fixed', inset: 0, zIndex: layer,
            background: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '20px',
        }}>
            {children}
        </div>
    );
}

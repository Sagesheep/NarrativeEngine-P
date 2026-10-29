export function Backdrop({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
    return (
        <div data-motion="overlay" onClick={onClick} style={{
            position: 'fixed', inset: 0, zIndex: 50,
            background: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '20px',
        }}>
            {children}
        </div>
    );
}

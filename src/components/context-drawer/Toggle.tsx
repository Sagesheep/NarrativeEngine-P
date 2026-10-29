export function Toggle({ active, onChange }: { active: boolean; onChange: () => void }) {
    return (
        <button
            onClick={(e) => { e.stopPropagation(); onChange(); }}
            className={`relative w-7 h-3.5 rounded-full transition-colors shrink-0 ${active ? 'bg-terminal' : 'bg-border'}`}
            title={active ? 'Active — will be appended' : 'Inactive — will not be appended'}
        >
            <div
                className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-surface transition-transform ${active ? 'translate-x-3.5' : 'translate-x-0.5'}`}
            />
        </button>
    );
}

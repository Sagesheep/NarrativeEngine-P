import type { ReactNode } from 'react';
import { Toggle } from './Toggle';

export function TemplateField({ icon, label, color, value, onChange, placeholder, rows, active, onToggle, hint }: {
    icon: ReactNode;
    label: string;
    color: string;
    value: string;
    onChange: (val: string) => void;
    placeholder: string;
    rows: number;
    active: boolean;
    onToggle: () => void;
    hint?: string;
}) {
    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <label className={`flex items-center gap-2 text-[13px] uppercase tracking-wider ${color}`}>
                    {icon}
                    {label}
                </label>
                <Toggle active={active} onChange={onToggle} />
            </div>
            <textarea
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                rows={rows}
                className={`w-full bg-void border px-3 py-2 text-xs text-text-primary placeholder:text-text-dim/40 font-mono resize-y transition-opacity ${active ? 'border-border' : 'border-border/40 opacity-50'
                    }`}
            />
            {hint && (
                <p className="text-[11px] text-text-dim/50 mt-1">{hint}</p>
            )}
        </div>
    );
}

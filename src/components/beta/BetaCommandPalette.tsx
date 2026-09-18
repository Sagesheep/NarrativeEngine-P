import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

/**
 * Beta UI — the command palette (audit F6).
 *
 * The classic app has exactly zero global keyboard shortcuts: Enter sends,
 * Shift+Enter newlines, and every other `keydown` listener in the codebase is a
 * modal closing itself on Escape. So every one of the fifteen-odd destinations
 * below costs a trip to the drawer with the mouse.
 *
 * Rather than scatter a dozen bindings nobody would memorise, this is one
 * surface on one binding. It dispatches to the SAME store actions the drawer
 * and header already call — it adds no capability, only a faster route to what
 * is already there, which is why it is safe to bolt on behind the flag.
 *
 * Mounted only when Beta UI is on (see ChatArea).
 */

interface Command {
    readonly id: string;
    readonly label: string;
    readonly group: string;
    readonly hint?: string;
    readonly run: () => void;
}

export function BetaCommandPalette() {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [cursor, setCursor] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const commands: Command[] = useMemo(() => {
        // Read actions off the store lazily at run time rather than subscribing:
        // the palette re-renders on keystrokes, and none of these identities
        // need to be reactive.
        const s = () => useAppStore.getState();
        return [
            { id: 'npc', group: 'Go to', label: 'Characters', run: () => s().toggleNPCLedger() },
            { id: 'places', group: 'Go to', label: 'Locations', run: () => s().toggleLocationLedger() },
            { id: 'pc', group: 'Go to', label: 'Your character', run: () => s().togglePCPanel() },
            { id: 'pinned', group: 'Go to', label: 'Pinned memories', run: () => s().togglePinnedMemories() },
            { id: 'gallery-gen', group: 'Go to', label: 'Gallery — AI generated', run: () => s().openGallery('generated') },
            { id: 'gallery-up', group: 'Go to', label: 'Gallery — uploaded', run: () => s().openGallery('uploaded') },
            { id: 'sys', group: 'Go to', label: 'System context', run: () => s().openContextScreen('sys') },
            { id: 'chpt', group: 'Go to', label: 'Chapters', run: () => s().openContextScreen('chpt') },
            { id: 'mem', group: 'Go to', label: 'Memory', run: () => s().openContextScreen('mem') },
            { id: 'lore', group: 'Go to', label: 'Lore', run: () => s().openContextScreen('world') },
            { id: 'eng', group: 'Go to', label: 'Engine tuning', run: () => s().openContextScreen('eng') },
            { id: 'blocks', group: 'Go to', label: 'Blocks', run: () => s().toggleBlockView() },
            { id: 'backups', group: 'Go to', label: 'Backups', run: () => s().toggleBackupModal() },

            { id: 'deep', group: 'This turn', label: 'Arm deep archive search', run: () => s().setDeepArmed(true) },
            { id: 'dice', group: 'This turn', label: 'Arm a dice roll', run: () => s().openDiceRollModal() },
            { id: 'undeep', group: 'This turn', label: 'Disarm deep search', run: () => s().setDeepArmed(false) },

            { id: 'drawer', group: 'View', label: 'Toggle the context drawer', run: () => s().toggleDrawer() },
            {
                id: 'theme', group: 'View', label: 'Switch light / dark',
                run: () => {
                    const current = s().settings?.theme;
                    const resolved = current === 'dark' ? 'light' : 'dark';
                    s().updateSettings({ theme: resolved });
                },
            },
            { id: 'settings', group: 'View', label: 'Settings', run: () => s().toggleSettings() },
            {
                id: 'beta-off', group: 'View', label: 'Turn Beta UI off',
                hint: 'back to the classic interface',
                run: () => s().updateSettings({ betaUi: false }),
            },
        ];
    }, []);

    const results = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return commands;
        return commands.filter(c =>
            c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
    }, [commands, query]);

    // Open on Cmd/Ctrl+K from anywhere, including while the composer has focus.
    // Nothing else is intercepted — this listener claims one chord and defers
    // every other key, so the composer's own Enter/Shift+Enter is untouched.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setOpen(prev => !prev);
                setQuery('');
                setCursor(0);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    useEffect(() => {
        if (open) inputRef.current?.focus();
    }, [open]);

    useEffect(() => {
        if (cursor >= results.length) setCursor(results.length > 0 ? results.length - 1 : 0);
    }, [results.length, cursor]);

    if (!open) return null;

    const runAt = (index: number) => {
        const command = results[index];
        if (!command) return;
        setOpen(false);
        setQuery('');
        try {
            command.run();
        } catch (error) {
            // A palette entry must never take the chat down with it.
            console.warn('[beta palette] command failed:', error);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor(c => Math.min(results.length - 1, c + 1));
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor(c => Math.max(0, c - 1));
            return;
        }
        if (e.key === 'Enter') { e.preventDefault(); runAt(cursor); }
    };

    let lastGroup = '';

    return (
        <div
            data-ui="palette-veil"
            role="dialog"
            aria-modal="true"
            aria-label="Commands"
            onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}
        >
            <div data-ui="palette">
                <div data-ui="palette-input">
                    <Search size={16} strokeWidth={1.8} aria-hidden="true" />
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={e => { setQuery(e.target.value); setCursor(0); }}
                        onKeyDown={onKeyDown}
                        placeholder="Type a command…"
                        aria-label="Search commands"
                    />
                    <kbd>esc</kbd>
                </div>
                <div data-ui="palette-list" ref={listRef}>
                    {results.length === 0 && (
                        <p data-ui="palette-empty">Nothing matches “{query}”.</p>
                    )}
                    {results.map((command, index) => {
                        const showGroup = command.group !== lastGroup;
                        lastGroup = command.group;
                        return (
                            <div key={command.id}>
                                {showGroup && <span data-ui="palette-group">{command.group}</span>}
                                <button
                                    type="button"
                                    data-ui="palette-row"
                                    data-selected={index === cursor ? 'true' : undefined}
                                    onMouseEnter={() => setCursor(index)}
                                    onClick={() => runAt(index)}
                                >
                                    <span>{command.label}</span>
                                    {command.hint && <i>{command.hint}</i>}
                                </button>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

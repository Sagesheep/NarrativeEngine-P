/**
 * Phase 4.2 — resolve a chrome entry's `icon` (a lucide name) to a React
 * component the host can render.
 *
 * `MOUNTS.md` §8.2: `icon` is a name, not a component. The host resolves it
 * against the icon set it already ships (`lucide-react`), so the entry stays
 * serialisable (Mod Management can render a mod's entries without mounting
 * the mod) and the mod's button is visually native. An unknown name is a
 * fault plus a neutral fallback glyph — **never a blank button**.
 *
 * The name is the PascalCase export name from `lucide-react` (e.g.
 * `'Swords'`, `'Syringe'`, `'Settings'`). The host resolves it lazily at
 * render time against the `icons` map `lucide-react` already exports, so a
 * future icon added upstream is available without touching this file.
 */
import { icons, HelpCircle, type LucideIcon } from 'lucide-react';

/**
 * The fallback glyph rendered when a chrome entry declares an unknown icon
 * name. `MOUNTS.md` §8.2: an unknown name is a fault plus a neutral fallback
 * glyph — never a blank button. Exported so the registry's `icon` fault path
 * and the renderer share one glyph.
 */
export const MOUNT_ICON_FALLBACK: LucideIcon = HelpCircle;

/**
 * Resolve a lucide icon name to its component, or the fallback if unknown.
 *
 * Returns the component (not the name) so a renderer can `<Icon size={13} />`
 * without re-resolving on every render. The caller records the `icon` fault
 * when the name is unknown; this helper only resolves.
 *
 * Lucide's `icons` map values are `React.forwardRef` components (objects
 * with a `$$typeof` marker), not plain functions, so the known-check
 * accepts any truthy value that is callable or a forwardRef component.
 */
export function resolveMountIcon(name: string): { icon: LucideIcon; known: boolean } {
    const found = (icons as Record<string, LucideIcon>)[name];
    if (found && (typeof found === 'function' || (found && typeof found === 'object' && '$$typeof' in found))) {
        return { icon: found as LucideIcon, known: true };
    }
    return { icon: MOUNT_ICON_FALLBACK, known: false };
}
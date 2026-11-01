/** Narrative Engine's semantic icons. Shared 24px grid and rounded strokes.
 * Standard interaction symbols remain Lucide for familiar, accessible controls.
 */
import { createLucideIcon, icons as lucideIcons, type IconNode } from 'lucide-react';
export * from 'lucide-react';

const make = (name: string, paths: string[]) => createLucideIcon(name,
    paths.map((d, i) => ['path', { d, key: `${name}-${i}` }]) as IconNode);

export const NarrativeMark = make('NarrativeMark', [
    'M12 21V12M12 16 8 12M12 12l4-4',
    'M12 21C9 18 5 18 3 18V6c3 0 6 1 9 4 3-3 6-4 9-4v12c-2 0-6 0-9 3Z',
    'm12 2 .7 2.3L15 5l-2.3.7L12 8l-.7-2.3L9 5l2.3-.7Z',
]);
export const BookOpen = make('BookOpen', ['M12 20V6M12 7C9 4 6 4 3 4v14c3 0 6 0 9 3 3-3 6-3 9-3V4c-3 0-6 0-9 3', 'M6 8l3 1M6 12l3 1M15 9l3-1M15 13l3-1']);
export const ScrollText = make('ScrollText', ['M6 4h12v15l-3-1.5-3 1.5-3-1.5L6 19V4ZM6 4H4v4h2M18 4h2v4h-2', 'M9 8h6M9 11h6M9 14h3']);
export const FileText = make('FileText', ['M5 3h10l4 4v14H5ZM15 3v5h4', 'M8 12h8M8 16h5']);
export const Brain = make('Brain', ['M12 3 4 7v10l8 4 8-4V7ZM4 7l8 5 8-5M12 12v9', 'M8 5v4l8 6v4M16 5v4l-8 6v4']);
export const Database = make('Database', ['M12 3 3 7l9 4 9-4-9-4ZM3 12l9 4 9-4M3 17l9 4 9-4', 'M3 7v3M21 7v3']);
export const Globe = make('Globe', ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18', 'M12 3c-5 5-5 13 0 18 5-5 5-13 0-18ZM5 6l3 2M19 18l-3-2']);
export const MapPin = make('MapPin', ['M18 9c0 5-6 10-6 10S6 14 6 9a6 6 0 1 1 12 0Z', 'M14 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5 18l-2 3h18l-2-3']);
export const Users = make('Users', ['M14 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM4 21v-3a7 7 0 0 1 14 0v3Z', 'M18 4a3 3 0 0 1 0 6M20 14c2 1 2 3 2 5']);
export const UserCircle = make('UserCircle', ['M12 2 3 6v7c0 5 9 9 9 9s9-4 9-9V6Z', 'M14.5 9a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM7 16c1-4 9-4 10 0']);
export const Workflow = make('Workflow', ['M9 3h6v6H9ZM3 15h6v6H3ZM15 15h6v6h-6Z', 'M12 9v3H6v3M12 12h6v3']);
export const Archive = make('Archive', ['M3 4h18v5H3ZM5 9v12h14V9', 'M9 13h6M12 13v4m-2-2 2 2 2-2']);
export const Pin = make('Pin', ['m8 3 8 0-1 6 4 5H5l4-5-1-6ZM12 14v7']);
export const Image = make('Image', ['M3 4h18v16H3ZM3 17l6-6 5 5 3-3 4 4', 'M17 8h.01']);
export const Sparkles = make('Sparkles', ['m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z', 'M19 2v4M17 4h4']);
export const Cpu = make('Cpu', ['M7 7h10v10H7ZM10 10h4v4h-4Z', 'M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4']);
export const Dice5 = make('Dice5', ['M12 2 3 7v10l9 5 9-5V7ZM3 7l9 5 9-5M12 12v10', 'M12 7h.01M7 13h.01M17 13h.01M7 16h.01M17 16h.01']);
export const SlidersHorizontal = make('SlidersHorizontal', ['M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10', 'M7 3v6M13 9v6M7 15v6']);

// Mods resolve icons by name; give them the same semantic artwork as the shell.
export const icons = { ...lucideIcons, BookOpen, ScrollText, FileText, Brain, Database,
    Globe, MapPin, Users, UserCircle, Workflow, Archive, Pin, Image, Sparkles, Cpu,
    Dice5, SlidersHorizontal };

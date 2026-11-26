/**
 * Parse `.archive.md` into scenes.
 *
 * Block format, as `appendScene` writes it:
 *
 *   ## SCENE 001
 *   *<timestamp>*
 *
 *   **[USER]**
 *   <player text>
 *
 *   **[GM]**
 *   <GM text>
 *
 *   ---
 *
 * GM replies use `---` themselves (most put one under their status line), so only
 * a block's LAST `---` ends the scene; everything between `**[GM]**` and it is the
 * GM text. Stopping at the first `---` cut 572 of 575 scenes of a real campaign
 * down to their status line on export.
 *
 * Parses an LF copy: archives written on Windows or edited by hand carry CRLF.
 *
 * @param {string} raw
 * @returns {{ sceneId: string, timestampText: string, userContent: string, assistantContent: string }[]}
 */
export function parseArchiveScenes(raw) {
    const GM_MARKER = '**[GM]**\n';
    const scenes = [];
    for (const block of String(raw ?? '').replace(/\r\n/g, '\n').split(/^(?=## SCENE )/m)) {
        const idMatch = block.match(/^## SCENE (\d+)/);
        if (!idMatch) continue;
        const timestampMatch = block.match(/^\*(.+)\*$/m);
        const userMatch = block.match(/\*\*\[USER\]\*\*\n([\s\S]*?)\n\n\*\*\[GM\]\*\*/);
        const gmStart = block.indexOf(GM_MARKER);
        const gm = gmStart >= 0 ? block.slice(gmStart + GM_MARKER.length) : '';
        scenes.push({
            sceneId: idMatch[1].padStart(3, '0'),
            timestampText: timestampMatch ? timestampMatch[1] : '',
            userContent: (userMatch ? userMatch[1] : '').trim(),
            assistantContent: gm.replace(/\n+---\s*$/, '').trim(),
        });
    }
    return scenes;
}

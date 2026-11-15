import type { CombatGrid, CombatPos, CombatTile } from '../../types';
import { TILE_SIZE } from './combatVisuals';
import { pixelUrl } from './pixelCatalog';
import { FADED_OPACITY } from './pixelMap';
import type { PixelMarker, PixelPlan, PlacedProp } from './pixelMap';

const ART_PIXEL = TILE_SIZE / 32;

const MARKER_COLORS: Record<PixelMarker, { fill: string; stroke: string; inset: number }> = {
    wall: { fill: '#596075', stroke: '#2f3445', inset: 0 },
    cover: { fill: '#9a7340', stroke: '#523b1c', inset: 2 },
    difficult: { fill: '#6f8f4e', stroke: '#3b5226', inset: 2 },
    hazard: { fill: '#e0622d', stroke: '#7d2410', inset: 2 },
};

const GRID_FAINT = 0.18;

const GRID_STRONG = 0.75;

function PixelImage({ path, x, y, w, h, layer, onFail, faded = false }: {
    path: string;
    x: number;
    y: number;
    w: number;
    h: number;
    layer: string;
    onFail: (path: string) => void;
    faded?: boolean;
}) {
    return (
        <image
            data-testid="combat-pixel-art"
            data-layer={layer}
            data-path={path}
            data-x={layer === 'prop' ? undefined : x}
            data-y={layer === 'prop' ? undefined : y}
            data-faded={faded ? 'true' : undefined}
            href={pixelUrl(path)}
            x={x * TILE_SIZE}
            y={y * TILE_SIZE}
            width={w * TILE_SIZE}
            height={h * TILE_SIZE}
            preserveAspectRatio="none"
            opacity={faded ? FADED_OPACITY : undefined}
            style={{ pointerEvents: 'none', imageRendering: 'pixelated' }}
            onError={() => onFail(path)}
        />
    );
}

export function PixelMarkerShape({ kind, x, y }: { kind: PixelMarker; x: number; y: number }) {
    const c = MARKER_COLORS[kind];
    const inset = c.inset * ART_PIXEL;
    return (
        <rect
            data-testid="combat-pixel-marker"
            data-tile={kind}
            data-x={x}
            data-y={y}
            x={x * TILE_SIZE + inset + ART_PIXEL / 2}
            y={y * TILE_SIZE + inset + ART_PIXEL / 2}
            width={TILE_SIZE - 2 * inset - ART_PIXEL}
            height={TILE_SIZE - 2 * inset - ART_PIXEL}
            shapeRendering="crispEdges"
            style={{ fill: c.fill, stroke: c.stroke, strokeWidth: ART_PIXEL, pointerEvents: 'none' }}
        />
    );
}

export function PixelPropImage({ prop, faded, onFail }: { prop: PlacedProp; faded: boolean; onFail: (path: string) => void }) {
    return (
        <image
            data-testid="combat-pixel-prop"
            data-prop={prop.id}
            data-path={prop.path}
            data-kind={prop.kind}
            data-mirror={prop.mirror ? 'true' : undefined}
            transform={prop.mirror ? `translate(${(2 * prop.x + prop.w) * TILE_SIZE} 0) scale(-1 1)` : undefined}
            data-faded={faded ? 'true' : undefined}
            href={pixelUrl(prop.path)}
            x={prop.x * TILE_SIZE}
            y={(prop.y - prop.up) * TILE_SIZE}
            width={prop.w * TILE_SIZE}
            height={(prop.h + prop.up) * TILE_SIZE}
            preserveAspectRatio="none"
            opacity={faded ? FADED_OPACITY : undefined}
            style={{ pointerEvents: 'none', imageRendering: 'pixelated' }}
            onError={() => onFail(prop.path)}
        />
    );
}

export function PixelTileLayer({ grid, plan, onTile, onHover, names, onFail, strongGrid }: {
    grid: CombatGrid;
    plan: PixelPlan;
    onTile?: (p: CombatPos) => void;
    onHover?: (p: CombatPos | null) => void;
    names?: Partial<Record<CombatTile, string>>;
    onFail: (path: string) => void;
    strongGrid: boolean;
}) {
    const floors = [];
    const decals = [];
    const ground = [];
    const lines = [];
    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            const i = y * grid.width + x;
            const tile = grid.tiles[i];
            const k = `${x},${y}`;
            const fill = plan.fillPaths[i];
            const floor = plan.floorPaths[i];
            if (fill) floors.push(<PixelImage key={k} path={fill} x={x} y={y} w={1} h={1} layer="fill" onFail={onFail} />);
            else if (floor) floors.push(<PixelImage key={k} path={floor} x={x} y={y} w={1} h={1} layer="floor" onFail={onFail} />);
            const decal = plan.decalPaths[i];
            if (decal) decals.push(<PixelImage key={k} path={decal} x={x} y={y} w={1} h={1} layer="decal" onFail={onFail} />);
            const overlay = plan.overlayPaths[i];
            if (overlay) ground.push(<PixelImage key={k} path={overlay} x={x} y={y} w={1} h={1} layer="overlay" onFail={onFail} />);
            const marker = plan.markers[i];
            if (marker) ground.push(<PixelMarkerShape key={`m${k}`} kind={marker} x={x} y={y} />);
            lines.push(
                <rect
                    key={k}
                    data-x={x}
                    data-y={y}
                    data-tile={tile}
                    x={x * TILE_SIZE}
                    y={y * TILE_SIZE}
                    width={TILE_SIZE}
                    height={TILE_SIZE}
                    shapeRendering="crispEdges"
                    style={{ fill: 'transparent', stroke: 'var(--combat-grid-line)', strokeWidth: 0.2, strokeOpacity: strongGrid ? GRID_STRONG : GRID_FAINT }}
                    onClick={onTile ? () => onTile({ x, y }) : undefined}
                    onMouseEnter={onHover ? () => onHover({ x, y }) : undefined}
                >
                    {names?.[tile] && <title>{names[tile]}</title>}
                </rect>,
            );
        }
    }
    return (
        <g data-testid="combat-tiles" data-art="on" data-style="pixel" data-grid={strongGrid ? 'strong' : 'faint'}>
            <rect x={0} y={0} width={grid.width * TILE_SIZE} height={grid.height * TILE_SIZE} style={{ fill: 'var(--combat-floor)', pointerEvents: 'none' }} />
            <g data-testid="combat-pixel-floors">{floors}</g>
            <g data-testid="combat-pixel-decals">{decals}</g>
            <g data-testid="combat-pixel-ground">{ground}</g>
            <g data-testid="combat-grid-lines">{lines}</g>
        </g>
    );
}

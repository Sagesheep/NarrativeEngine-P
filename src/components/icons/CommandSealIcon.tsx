// Absolute Command v1 — sideways Command Seal icon.
//
// Traced from `CommandSeals.jpg` (608x1000 source; glyph bbox 266x827) by
// thresholding the red channel, crack-following the mask boundary, Chaikin
// smoothing, then Ramer-Douglas-Peucker at 1.2 source-pixels — about 0.15% of
// the glyph height, so the simplification is invisible at any size the UI uses.
// Hand-editing these coordinates is not useful; re-run the trace instead.
//
// The seal's true aspect is 1 : 3.11 (NOT the 60x100 the WO originally guessed
// — that was an eyeball estimate; the trace is authoritative). It is authored
// UPRIGHT in a 32.16 x 100 box and rotated -90deg here so its long axis runs
// horizontal, which is what lets it render several times larger inside a 32px
// button than an upright seal could.
//
// The rotation lives INSIDE the svg, not in CSS: a CSS transform does not change
// the layout box, so the button would reserve a tall-narrow slot for a
// wide-short icon and the label would sit wrong.
// `translate(0,32.16) rotate(-90)` maps upright (x,y) -> (y, 32.16-x), landing
// the upright box exactly in the rotated 100 x 32.16 viewBox with the spike
// pointing LEFT, into the label.
//
// fill-rule="evenodd" is REQUIRED, not cosmetic: the fourth subpath is the
// hollow interior of the bottom chevron. Under the default nonzero rule that
// chevron fills solid and the glyph reads as a blob.

const UPRIGHT_W = 32.16;
const UPRIGHT_H = 100;

/** Rendered width ÷ height. `size` is the height; width follows from this. */
export const COMMAND_SEAL_ASPECT = UPRIGHT_H / UPRIGHT_W;

const SEAL_PATH = [
    // Top spike.
    'M16.13 0L16.68 6.6L17.05 8.28L17.29 12.04L18.01 16.26L18.02 17.37L18.38 18.54L18.98 22.93L20.31 28.6L18.63 30.37L17.66 32.07L16.31 35.65L15.99 35.67L15.84 35.38L15.71 34.61L14.38 31.71L13.05 29.64L11.61 28.23L11.85 27.24L12.09 27.05L13.06 22.57L13.18 21.08L13.42 20.76L14.51 12.49L14.75 11.92L15.84 0.42L16.07 0.59Z',
    // Middle wings.
    'M23.27 27.69L23.45 27.73L23.46 29.33L24.3 34.66L25.27 38.65L25.51 38.85L25.63 39.86L25.87 40.05L26.97 43.87L29.99 50.52L32.15 53.79L31.7 53.8L30 52.59L28.06 50.65L26.37 48.23L25.38 46.21L25.08 46.07L22.75 47.41L20.69 49.35L19.23 51.42L18.14 53.72L17.65 55.59L17.3 55.72L17.53 52.28L18.87 48.52L20.44 46.21L22.26 44.39L24.05 43.14L22.94 38.94L21.07 39.3L19.01 40.27L16.7 41.97L16.3 42.55L15.89 42.68L14.73 41.37L13.15 40.27L11.46 39.43L9.22 38.82L8.95 39.22L8.1 43.01L9.21 44L9.65 44.15L11.18 45.71L13.17 48.52L14.02 50.45L14.63 53.02L14.61 55.97L13.54 52.87L11.72 49.72L9.41 47.41L7.34 46.07L6.66 46.21L6.04 47.61L4.22 50.4L1.43 53.07L0.21 53.8L0.22 53.58L0 53.64L2.17 50.39L3.86 46.89L5.43 42.9L7.74 34.91L8.58 29.94L8.72 27.83L8.94 27.84L9.19 28.7L9.31 30.43L9.55 31.01L9.56 36.13L10.97 36.77L12.31 37.74L14.62 40.04L15.73 41.82L16.15 41.96L19.12 38.1L20.57 37.01L22.6 36.01L22.49 31.98L22.85 29.06Z',
    // Lower crescents + chevron.
    'M10.69 59.01L12.55 59.75L14.38 61.45L15.35 63.03L16.01 64.81L16.44 64.42L16.69 63.15L18.15 60.96L19.98 59.5L21.08 59.01L21.51 59.15L19.96 60.48L18.99 62.18L18.5 64.02L18.5 66.09L18.99 68.05L20.08 69.87L21.18 70.85L22.65 71.58L23.87 71.83L25.23 71.7L27.55 70.48L29.13 68.29L29.74 66.34L29.74 64.73L29.98 64.49L30.23 67.54L29.86 69.5L28.64 71.81L27.06 73.39L25.15 74.39L19.22 91.59L16.32 99.85L15.97 99.98L6.89 74.39L4.73 73.14L3.88 72.29L3.03 71.07L2.18 69.13L1.93 67.54L2.12 64.93L2.66 67.43L3.15 68.66L4.85 70.73L6.19 71.46L7.67 71.83L9.15 71.7L11.35 70.61L12.2 69.63L12.69 69.02L13.42 67.31L13.54 63.54L13.05 61.94L12.44 60.84L11.71 59.99L10.77 59.35L10.86 59.14L10.65 59.23Z',
    // Hollow interior of the chevron — relies on fill-rule="evenodd".
    'M16.03 68.68L15.35 70.59L14.01 72.53L12.3 73.88L10.03 74.78L15.36 93.79L15.72 95.01L16.01 95.28L16.56 94.04L22 75.04L21.99 74.62L19.98 74L17.9 72.29L16.93 70.83L16.32 68.95Z',
].join('');

export function CommandSealIcon({ size = 14 }: { size?: number } = {}) {
    return (
        <svg
            viewBox={`0 0 ${UPRIGHT_H} ${UPRIGHT_W}`}
            width={size * COMMAND_SEAL_ASPECT}
            height={size}
            fill="currentColor"
            fillRule="evenodd"
            aria-hidden="true"
            className="shrink-0"
        >
            <g transform={`translate(0,${UPRIGHT_W}) rotate(-90)`}>
                <path d={SEAL_PATH} />
            </g>
        </svg>
    );
}

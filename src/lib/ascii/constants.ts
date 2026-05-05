export const DEFAULT_FG = '#c8c8c8';
export const DEFAULT_BG = '#000000';
// Loaded via Google Fonts in src/app.html with `display=block` so no chars
// are rendered before the font is ready (prevents per-glyph fallback from
// system fonts with mismatched advance widths shifting rows horizontally).
// JetBrains Mono covers Latin, Block Elements, Box Drawing, Braille Patterns,
// and the eighth-block chars we use — all at one consistent advance.
export const FONT_FAMILY = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
export const FONT_SIZE_PX = 14;
// 1.0 = tight like alacritty/xterm; bump to 1.1–1.2 for more breathing room.
export const LINE_HEIGHT = 1.0;

export const DEFAULT_RAMP = ' .:-=+*#%@';

export const BORDER_STYLES = {
	single:  { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
	double:  { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
	rounded: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
	heavy:   { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' }
} as const;

// Braille sub-pixel grid: each cell holds a 2×4 dot bitmask at U+2800.
// Bit layout (dot → bit): 1→0x01, 2→0x02, 3→0x04, 4→0x08, 5→0x10,
// 6→0x20, 7→0x40, 8→0x80. Sub-pixel (sx,sy) ∈ {0,1}×{0..3} → bit.
export const BRAILLE_BASE = 0x2800;
export const BRAILLE_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];

// Marching-squares default char map. Case index bits: TL=1, TR=2, BR=4, BL=8.
export const MS_DEFAULT_CHARS = [
	' ', '╯', '╰', '─',
	'╮', '╲', '│', '╮',
	'╭', '│', '╱', '╭',
	'─', '╰', '╯', ' '
];

// Bayer matrices for ordered dither. Values are integer indices within size²
// ticks; threshold = (v+0.5)/size².
export const BAYER_2 = [
	[0, 2],
	[3, 1]
];
export const BAYER_4 = [
	[ 0,  8,  2, 10],
	[12,  4, 14,  6],
	[ 3, 11,  1,  9],
	[15,  7, 13,  5]
];
export const BAYER_8 = [
	[ 0, 32,  8, 40,  2, 34, 10, 42],
	[48, 16, 56, 24, 50, 18, 58, 26],
	[12, 44,  4, 36, 14, 46,  6, 38],
	[60, 28, 52, 20, 62, 30, 54, 22],
	[ 3, 35, 11, 43,  1, 33,  9, 41],
	[51, 19, 59, 27, 49, 17, 57, 25],
	[15, 47,  7, 39, 13, 45,  5, 37],
	[63, 31, 55, 23, 61, 29, 53, 21]
];

export const CH_SPACE = 32;
export const CH_LT = 60;
export const CH_GT = 62;
export const CH_AMP = 38;

export const DEF_FG_IDX = 0;
export const DEF_BG_IDX = 1;

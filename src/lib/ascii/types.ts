import type { BORDER_STYLES } from './constants';

export type Cell = { char: string; fg: string; bg: string };
export type BorderStyle = keyof typeof BORDER_STYLES;

export interface DitherOpts {
	rect?: { x: number; y: number; w: number; h: number };
	ramp?: string;
	fg?: string;
	bg?: string;
	type?: 'threshold' | 'ordered' | 'floyd-steinberg';
	bayerSize?: 2 | 4 | 8;
	serpentine?: boolean;
	levels?: number;
}

export interface TextBoxOpts {
	fg?: string;
	bg?: string;
	align?: 'left' | 'center' | 'right';
	valign?: 'top' | 'middle' | 'bottom';
	wrap?: 'word' | 'char' | 'none';
	overflow?: 'clip' | 'ellipsis';
	ellipsis?: string;
	padding?:
		| number
		| { x: number; y: number }
		| { top: number; right: number; bottom: number; left: number };
	border?: boolean | BorderStyle;
	borderFg?: string;
	borderBg?: string;
	lineSpacing?: number;
	clearBg?: boolean;
	shadow?: string;
}

export interface DebugBoxOpts {
	title?: string;
	/** Decimal places for non-integer numbers. Default 2. */
	precision?: number;
	/** Override the auto-sized width / height. */
	w?: number;
	h?: number;
	fg?: string;
	bg?: string;
	border?: boolean | BorderStyle;
	borderFg?: string;
	borderBg?: string;
	padding?:
		| number
		| { x: number; y: number }
		| { top: number; right: number; bottom: number; left: number };
	shadow?: string;
	clearBg?: boolean;
	/** Color for keys (labels). Defaults to fg. */
	keyFg?: string;
	/** Color for values. Defaults to fg. */
	valFg?: string;
}

export interface MouseState {
	x: number;
	y: number;
	px: number;
	py: number;
	fx: number;
	fy: number;
}

export interface KeysApi {
	isDown(k: string): boolean;
	justPressed(k: string): boolean;
}

export interface ProfileFrameStat {
	frame: number;
	effectMs: number;
	renderMs: number;
	totalMs: number;
	textPathCount: number;
	textPathMs: number;
	uniformPathCount: number;
	uniformPathMs: number;
	htmlPathCount: number;
	htmlPathMs: number;
	paletteSize: number;
	dirtyRowsRendered: number;
	cols: number;
	rows: number;
}

export interface ProfileApi {
	readonly enabled: boolean;
	readonly frames: ProfileFrameStat[];
	reset(): void;
}

export interface AsciiApi {
	readonly cols: number;
	readonly rows: number;
	readonly elapsed: number;
	readonly dt: number;
	readonly frame: number;
	readonly fps: number;
	readonly cellAspect: number;
	mouse: MouseState;
	keys: KeysApi;
	set(x: number, y: number, char: string, fg?: string, bg?: string): void;
	// Hot-path primitives: resolve palette index once with `color`, then call
	// `setI` / `blit` to skip per-call Map lookups. See CLAUDE.md perf notes.
	color(s: string): number;
	setI(x: number, y: number, code: number, fIdx: number, bIdx: number): void;
	blit(chars: Uint16Array, fg: Uint16Array, bg: Uint16Array): void;
	get(x: number, y: number): Cell | null;
	fill(char: string, fg?: string, bg?: string): void;
	clear(): void;
	fillRect(x: number, y: number, w: number, h: number, char: string, fg?: string, bg?: string): void;
	strokeRect(x: number, y: number, w: number, h: number, char: string, fg?: string, bg?: string): void;
	line(x0: number, y0: number, x1: number, y1: number, char: string, fg?: string, bg?: string): void;
	circle(cx: number, cy: number, r: number, char: string, fg?: string, bg?: string): void;
	fillCircle(cx: number, cy: number, r: number, char: string, fg?: string, bg?: string): void;
	border(x: number, y: number, w: number, h: number, style: BorderStyle, fg?: string, bg?: string): void;
	text(x: number, y: number, str: string, fg?: string, bg?: string): void;
	textCentered(x: number, y: number, str: string, fg?: string, bg?: string): void;
	textRight(x: number, y: number, str: string, fg?: string, bg?: string): void;
	textBox(x: number, y: number, w: number, h: number, str: string, opts?: TextBoxOpts): void;
	debugBox(x: number, y: number, stats: Record<string, unknown>, opts?: DebugBoxOpts): void;
	forEach(fn: (x: number, y: number, cell: Cell, i: number) => void): void;
	forRect(x: number, y: number, w: number, h: number, fn: (x: number, y: number) => void): void;
	ramp(t: number, chars?: string): string;
	field(
		fn: (x: number, y: number) => number,
		ramp?: string,
		fg?: string,
		bg?: string
	): void;
	// Fast-path `field` for data already in a typed array. Skips the per-cell
	// closure call — use when the values come from a precomputed buffer.
	fieldArr(
		values: Float32Array | Float64Array,
		ramp?: string,
		fg?: string,
		bg?: string
	): void;
	fieldRect(
		x: number,
		y: number,
		w: number,
		h: number,
		fn: (x: number, y: number) => number,
		ramp?: string,
		fg?: string,
		bg?: string
	): void;
	contour(
		fn: (x: number, y: number) => number,
		levels: number | number[],
		charFor?: (case_: number, level: number) => string | null
	): void;
	dither(fn: (x: number, y: number) => number, opts?: DitherOpts): void;
	bset(px: number, py: number, fg?: string): void;
	bline(x0: number, y0: number, x1: number, y1: number, fg?: string): void;
	bcircle(cx: number, cy: number, r: number, fg?: string): void;
	bclear(): void;
	rgb(r: number, g: number, b: number): string;
	hsl(h: number, s: number, l: number): string;
	// Quantized variants — inputs are rounded to `bins` steps so the palette
	// Map stays bounded under animated color math. Prefer these in per-frame
	// inner loops over plain rgb/hsl.
	rgbQ(r: number, g: number, b: number, bins?: number): string;
	hslQ(h: number, s: number, l: number, bins?: number): string;
	lerpColor(a: string, b: string, t: number): string;
	profile: ProfileApi;
}

export type Effect = (c: AsciiApi) => void;

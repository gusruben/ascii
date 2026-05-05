/*
 * Glyph-shape matcher.
 *
 * At first use we rasterize every printable ASCII character (codepoints
 * 32..126) into a fixed-resolution binary sub-cell mask, painting each glyph
 * inside the SAME cell box (advance × line-height) that the renderer commits
 * to the DOM. The atlas thus captures both the glyph's actual ink shape AND
 * the surrounding empty space — `(` is correctly seen as "ink in the left
 * 70% of the cell, blank along the right edge", which is exactly the kind
 * of position information the matcher needs.
 *
 * Effects (e.g. mandelbrot's shape modes) build a per-cell binary target
 * mask by sampling whatever underlying field they care about at the same
 * sub-cell grid, then call `matchMask(target)` to retrieve the index of
 * the glyph whose ink most closely matches.
 *
 * The mask is 8 wide × 16 tall = 128 bits, packed into 4 × Uint32 so SAD
 * (Hamming distance) is four XOR-and-popcount ops per glyph compare.
 */

import { FONT_FAMILY, FONT_SIZE_PX, LINE_HEIGHT } from './constants';

/** Sub-cell mask grid width. */
export const GW = 8;
/** Sub-cell mask grid height — matches the typical 1:2 cell aspect. */
export const GH = 16;
export const GAREA = GW * GH;
/** Number of Uint32 words per packed mask (= 4). */
export const MASK_WORDS = (GAREA + 31) >>> 5;

/** A packed binary mask. Length must be `MASK_WORDS`. */
export type Mask = Uint32Array;

export interface GlyphAtlas {
	/** Character strings, parallel to `codes`/`inks`. Index 0 is space. */
	readonly chars: readonly string[];
	/** UTF-16 codepoints, parallel to `chars`. */
	readonly codes: Uint16Array;
	/** Flat masks: glyph i at offset `i * MASK_WORDS`. */
	readonly masksFlat: Uint32Array;
	/** popcount(masksFlat[i]) per glyph — used for tie-breaks. */
	readonly inks: Uint8Array;
	/** Number of glyphs. */
	readonly N: number;
}

let _atlas: GlyphAtlas | null = null;
let _weights: Float32Array | null = null;

const popcount = (n: number): number => {
	n = n - ((n >>> 1) & 0x55555555);
	n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
	n = (n + (n >>> 4)) & 0x0f0f0f0f;
	return (n * 0x01010101) >>> 24;
};

/**
 * Bilinear weight table: for sub-cell index i the four contiguous floats
 * are the (TL, TR, BL, BR) weights summing to 1. Lets effects build a
 * target mask by interpolating four corner values across the sub-cell grid
 * with a single multiply-add per axis.
 */
export function getBilinearWeights(): Float32Array {
	if (_weights) return _weights;
	const w = new Float32Array(GAREA * 4);
	for (let sy = 0; sy < GH; sy++) {
		const v = (sy + 0.5) / GH;
		for (let sx = 0; sx < GW; sx++) {
			const u = (sx + 0.5) / GW;
			const off = (sy * GW + sx) * 4;
			w[off + 0] = (1 - u) * (1 - v);
			w[off + 1] = u * (1 - v);
			w[off + 2] = (1 - u) * v;
			w[off + 3] = u * v;
		}
	}
	_weights = w;
	return w;
}

/** Allocate a fresh empty mask. Cheaper to reuse a scratch one across cells. */
export function maskAlloc(): Mask {
	return new Uint32Array(MASK_WORDS);
}

export function maskBit(m: Mask, i: number): number {
	return (m[i >>> 5] >>> (i & 31)) & 1;
}

export function maskInk(m: Mask): number {
	let s = 0;
	for (let i = 0; i < MASK_WORDS; i++) s += popcount(m[i]);
	return s;
}

function measureCellWidth(): number {
	const probe = document.createElement('span');
	probe.style.cssText =
		`position:absolute;visibility:hidden;font-family:${FONT_FAMILY};` +
		`font-size:${FONT_SIZE_PX}px;white-space:pre;line-height:1;`;
	probe.textContent = 'M'.repeat(100);
	document.body.appendChild(probe);
	const w = probe.getBoundingClientRect().width / 100;
	document.body.removeChild(probe);
	return w;
}

/**
 * Build (lazily) and return the glyph atlas. The atlas exists for the
 * lifetime of the page — it depends only on the runtime's font/size
 * constants, neither of which change at runtime.
 *
 * We oversample (SCALE×) when rasterizing so each sub-cell averages many
 * real pixels, giving stable thresholding even at fractional cell sizes
 * (e.g. on HiDPI screens or when the glyph's ink straddles a sub-cell
 * boundary). The threshold (0.30) is conservative — bias toward "ink
 * present" so thin features (apostrophe, period, comma) survive
 * downsampling.
 */
export function getGlyphAtlas(): GlyphAtlas {
	if (_atlas) return _atlas;

	const cellW = measureCellWidth();
	const cellH = FONT_SIZE_PX * LINE_HEIGHT;

	const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
	const SCALE = 4;
	const cw = Math.max(1, Math.ceil(cellW * dpr) * SCALE);
	const ch = Math.max(1, Math.ceil(cellH * dpr) * SCALE);

	const canvas = document.createElement('canvas');
	canvas.width = cw;
	canvas.height = ch;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) throw new Error('glyphShape: 2d context unavailable');
	ctx.font = `${FONT_SIZE_PX * dpr * SCALE}px ${FONT_FAMILY}`;
	ctx.textBaseline = 'top';
	ctx.imageSmoothingEnabled = true;

	const chars: string[] = [];
	for (let i = 32; i <= 126; i++) chars.push(String.fromCharCode(i));
	const N = chars.length;

	const masksFlat = new Uint32Array(N * MASK_WORDS);
	const inks = new Uint8Array(N);
	const codes = new Uint16Array(N);
	for (let n = 0; n < N; n++) codes[n] = chars[n].charCodeAt(0);

	const THRESH = 0.3;

	for (let n = 0; n < N; n++) {
		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, cw, ch);
		ctx.fillStyle = '#fff';
		ctx.fillText(chars[n], 0, 0);
		const data = ctx.getImageData(0, 0, cw, ch).data;

		const off = n * MASK_WORDS;
		let inkCount = 0;
		for (let sy = 0; sy < GH; sy++) {
			const py0 = Math.floor((sy * ch) / GH);
			const py1 = Math.max(py0 + 1, Math.floor(((sy + 1) * ch) / GH));
			for (let sx = 0; sx < GW; sx++) {
				const px0 = Math.floor((sx * cw) / GW);
				const px1 = Math.max(px0 + 1, Math.floor(((sx + 1) * cw) / GW));
				let total = 0;
				let count = 0;
				for (let py = py0; py < py1; py++) {
					const rowOff = py * cw * 4;
					for (let px = px0; px < px1; px++) {
						total += data[rowOff + px * 4];
						count++;
					}
				}
				const avg = total / (count * 255);
				if (avg > THRESH) {
					const i = sy * GW + sx;
					masksFlat[off + (i >>> 5)] |= 1 << (i & 31);
					inkCount++;
				}
			}
		}
		inks[n] = inkCount > 255 ? 255 : inkCount;
	}

	_atlas = { chars, codes, masksFlat, inks, N };
	// Expose console debug helpers — call `__glyphShape.dumpFullAtlas()` or
	// `__glyphShape.probeMatch(asciiArt)` from devtools to inspect what the
	// matcher is doing for a particular cell shape.
	if (typeof globalThis !== 'undefined') {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(globalThis as any).__glyphShape = {
			atlas: _atlas,
			dumpFullAtlas,
			probeMatch,
			logAtlasSamples,
			matchMask,
			GW,
			GH
		};
	}
	return _atlas;
}

/**
 * Match a target mask to the closest atlas glyph.
 *
 * Distance is plain Hamming (popcount of XOR) — sub-cell pixels where the
 * target and glyph disagree, lower is better. Four adjustments:
 *
 *   1. NOISE-FLOOR TARGET → SPACE. Targets with ≤ `emptyThreshold` ink
 *      sub-cells (default 2 of 128) emit a literal space, no scoring
 *      loop. At this resolution a 1- or 2-pixel target is almost always
 *      interpolation noise from a corner that's a hair past threshold,
 *      not a real feature. Set `emptyThreshold = 0` to disable.
 *
 *   2. ABOVE NOISE FLOOR + GLYPH BEATS SPACE → GLYPH. We score every
 *      non-space glyph and pick the lowest SAD; if a tiny dot in the
 *      middle of the cell has a glyph that lines up with it, we emit
 *      that glyph rather than swallowing the feature.
 *
 *   3. NO GLYPH BEATS SPACE → SPACE ANYWAY. Space's SAD against any
 *      target equals `tInkN` (it disagrees on every ink sub-cell). If
 *      the best glyph's SAD ≥ `tInkN`, the glyph contributes more
 *      disagreement than it covers — a small ink cluster on the wrong
 *      side of the cell from where the target's ink sits — and we
 *      emit space instead. Without this guard top-only glyphs (`\``,
 *      `'`) habitually win on thin slivers by accident, reading as
 *      random scratches floating above the actual feature.
 *
 *   4. TIE-BREAK TOWARD LOWER INK. When two glyphs match equally well
 *      we pick the simpler one — keeps borderline cells reading clean.
 */
export function matchMask(
	target: Mask,
	atlas: GlyphAtlas = getGlyphAtlas(),
	emptyThreshold: number = 2
): number {
	const { masksFlat, inks, N } = atlas;

	const t0 = target[0] | 0;
	const t1 = target[1] | 0;
	const t2 = target[2] | 0;
	const t3 = target[3] | 0;

	let tInk = t0 - ((t0 >>> 1) & 0x55555555);
	tInk = (tInk & 0x33333333) + ((tInk >>> 2) & 0x33333333);
	tInk = ((tInk + (tInk >>> 4)) & 0x0f0f0f0f) * 0x01010101;
	let tInkN = (tInk >>> 24) & 0xff;
	let p = t1 - ((t1 >>> 1) & 0x55555555);
	p = (p & 0x33333333) + ((p >>> 2) & 0x33333333);
	tInkN += (((p + (p >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
	p = t2 - ((t2 >>> 1) & 0x55555555);
	p = (p & 0x33333333) + ((p >>> 2) & 0x33333333);
	tInkN += (((p + (p >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
	p = t3 - ((t3 >>> 1) & 0x55555555);
	p = (p & 0x33333333) + ((p >>> 2) & 0x33333333);
	tInkN += (((p + (p >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;

	if (tInkN <= emptyThreshold) return 0; // index 0 is space (codepoint 32)

	let bestI = 1;
	let bestSAD = 1 << 30;
	let bestInk = 256;

	for (let i = 1; i < N; i++) {
		const off = i << 2;
		let n = (masksFlat[off] ^ t0) >>> 0;
		n = n - ((n >>> 1) & 0x55555555);
		n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
		n = (n + (n >>> 4)) & 0x0f0f0f0f;
		let sad = (n * 0x01010101) >>> 24;

		n = (masksFlat[off + 1] ^ t1) >>> 0;
		n = n - ((n >>> 1) & 0x55555555);
		n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
		n = (n + (n >>> 4)) & 0x0f0f0f0f;
		sad += (n * 0x01010101) >>> 24;

		n = (masksFlat[off + 2] ^ t2) >>> 0;
		n = n - ((n >>> 1) & 0x55555555);
		n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
		n = (n + (n >>> 4)) & 0x0f0f0f0f;
		sad += (n * 0x01010101) >>> 24;

		n = (masksFlat[off + 3] ^ t3) >>> 0;
		n = n - ((n >>> 1) & 0x55555555);
		n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
		n = (n + (n >>> 4)) & 0x0f0f0f0f;
		sad += (n * 0x01010101) >>> 24;

		const ink = inks[i];
		if (sad < bestSAD || (sad === bestSAD && ink < bestInk)) {
			bestSAD = sad;
			bestI = i;
			bestInk = ink;
		}
	}

	// "Must beat space" guard. Space's SAD against any target is exactly
	// `tInkN` (it disagrees on every ink sub-cell). If the best glyph's
	// SAD is no better than that, emit space rather than the glyph: it
	// means the glyph contributes more disagreement than it covers,
	// usually a small ink cluster on the wrong side of the cell from
	// where the target's ink actually sits. Without this guard, top-only
	// glyphs (`\``, `'`) routinely win on cells whose target is a thin
	// sliver, even when they line up only by accident — they look like
	// random scratches floating above the actual feature.
	if (bestSAD >= tInkN) return 0;
	return bestI;
}

/** Render a mask as ASCII art (`█` for ink, `·` for empty). Debug aid. */
export function maskToAsciiArt(m: Mask): string {
	const rows: string[] = [];
	for (let y = 0; y < GH; y++) {
		let r = '';
		for (let x = 0; x < GW; x++) {
			const i = y * GW + x;
			r += (m[i >>> 5] >>> (i & 31)) & 1 ? '█' : '·';
		}
		rows.push(r);
	}
	return rows.join('\n');
}

/**
 * Log a sample of the atlas to the console — used to verify on first build
 * that the canvas-rasterized masks line up with what the font actually
 * paints. Selects characters that exercise different shape regions
 * (corners, edges, center, full, sparse).
 */
export function logAtlasSamples(): void {
	if (typeof console === 'undefined') return;
	const atlas = getGlyphAtlas();
	const samples = [' ', '.', ',', "'", '`', '_', '-', '"', ':', ';', '/', '\\', '|', '(', ')', 'O', 'i', 'A', '#', '@'];
	const lines: string[] = [`[glyphShape] atlas built — ${atlas.N} glyphs at ${GW}×${GH}. Samples:`];
	for (const ch of samples) {
		const idx = atlas.chars.indexOf(ch);
		if (idx < 0) continue;
		const m = atlas.masksFlat.subarray(idx * MASK_WORDS, (idx + 1) * MASK_WORDS) as Mask;
		lines.push(`'${ch}' (ink=${atlas.inks[idx]}):`);
		lines.push(maskToAsciiArt(m));
	}
	// eslint-disable-next-line no-console
	console.log(lines.join('\n'));
}

/**
 * Dump the FULL atlas — every glyph, every mask — so the user can grab a
 * faithful copy of what the matcher is actually working with and share it
 * back. Helpful for diagnosing "why is X getting picked here?" without a
 * round-trip in front of the screen.
 */
export function dumpFullAtlas(): string {
	const atlas = getGlyphAtlas();
	const lines: string[] = [`# glyphShape atlas — ${atlas.N} glyphs at ${GW}×${GH}`];
	for (let n = 0; n < atlas.N; n++) {
		const m = atlas.masksFlat.subarray(n * MASK_WORDS, (n + 1) * MASK_WORDS) as Mask;
		lines.push(`'${atlas.chars[n]}' (cp=${atlas.codes[n]}, ink=${atlas.inks[n]})`);
		lines.push(maskToAsciiArt(m));
		lines.push('');
	}
	return lines.join('\n');
}

/**
 * Probe a synthetic target: build a binary mask from an ASCII art shape
 * (one row per line, `#` or `1` for ink, anything else for empty), report
 * the top-K glyph matches with their SAD scores. Designed to be called
 * from the browser console — paste in the cell mask the user is curious
 * about and it prints what the matcher would pick and why.
 */
export function probeMatch(asciiArt: string, k: number = 8): string {
	const atlas = getGlyphAtlas();
	const target = new Uint32Array(MASK_WORDS);
	const rows = asciiArt.split('\n').slice(0, GH);
	for (let y = 0; y < rows.length; y++) {
		const row = rows[y];
		for (let x = 0; x < GW && x < row.length; x++) {
			const ch = row[x];
			if (ch === '#' || ch === '1' || ch === '█') {
				const i = y * GW + x;
				target[i >>> 5] |= 1 << (i & 31);
			}
		}
	}
	const tInk =
		((target[0] >>> 0) === 0 ? 0 : popcount32(target[0])) +
		popcount32(target[1]) +
		popcount32(target[2]) +
		popcount32(target[3]);
	type Score = { ch: string; sad: number; ink: number };
	const scores: Score[] = [];
	for (let i = 0; i < atlas.N; i++) {
		const off = i * MASK_WORDS;
		const sad =
			popcount32((atlas.masksFlat[off] ^ target[0]) >>> 0) +
			popcount32((atlas.masksFlat[off + 1] ^ target[1]) >>> 0) +
			popcount32((atlas.masksFlat[off + 2] ^ target[2]) >>> 0) +
			popcount32((atlas.masksFlat[off + 3] ^ target[3]) >>> 0);
		scores.push({ ch: atlas.chars[i], sad, ink: atlas.inks[i] });
	}
	scores.sort((a, b) => a.sad - b.sad || a.ink - b.ink);
	const lines: string[] = [
		`target ink=${tInk}, "must beat space" cutoff = SAD < ${tInk}`,
		maskToAsciiArt(target),
		`top ${k}:`
	];
	for (let i = 0; i < k && i < scores.length; i++) {
		const s = scores[i];
		const passes = s.sad < tInk ? 'pass' : 'BLOCKED';
		lines.push(`  '${s.ch}' SAD=${s.sad} ink=${s.ink} [${passes}]`);
	}
	const chosen = matchMask(target, atlas);
	lines.push(`matcher returns: '${atlas.chars[chosen]}' (idx ${chosen})`);
	return lines.join('\n');
}

function popcount32(n: number): number {
	n = n - ((n >>> 1) & 0x55555555);
	n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
	n = (n + (n >>> 4)) & 0x0f0f0f0f;
	return (n * 0x01010101) >>> 24;
}

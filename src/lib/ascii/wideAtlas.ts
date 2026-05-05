/*
 * Wide-character glyph atlas for shape-matched rendering at scale.
 *
 * Where the ASCII-only atlas in `glyphShape.ts` has 95 glyphs, this one
 * rasterizes ~2,000 candidate Unicode characters across 13 code-point
 * ranges (Latin extended, Greek, Cyrillic, Arrows, Math, Box Drawing,
 * Block Elements, Geometric Shapes, Misc Symbols, Dingbats, Braille).
 *
 * The atlas would be slow to use naively — a brute-force `matchMask`
 * over N glyphs is O(N) per cell, and at N≈1500 plus 12,000 cells per
 * frame that's tens of millions of XOR-popcount-min cycles. Two
 * structural optimizations get it back to interactive speed:
 *
 *   1. DEDUPE BY MASK HASH. Rasterized at 8×16 sub-cell resolution,
 *      thousands of Unicode characters collapse into hundreds of
 *      *unique* shapes. Visually identical glyphs (Latin 'A' vs Greek
 *      Alpha, ZWSP vs other zero-ink fallbacks) are merged into one
 *      atlas slot. Cuts N by 30-50% for free, with no quality loss.
 *
 *   2. SIGNATURE BUCKETS. Each glyph gets an 8-bit signature (2 cols ×
 *      4 rows of 4×4 sub-regions, each bit = "majority-ink in this
 *      region"). 256 buckets total. At match time we compute the
 *      target's signature and only score candidates in that bucket —
 *      plus its 8 hamming-1 neighbors so we don't miss matches whose
 *      signature differs by one borderline region. Iteration count
 *      drops from ~1500 to ~30-60 candidates per match.
 *
 *   3. EARLY-OUT SAD. The 4-word XOR-popcount accumulates into `sad`;
 *      if `sad` already exceeds `bestSAD` after any partial sum, we
 *      abandon the candidate. Skips the 6-op popcount on every word
 *      after the first that proves a glyph won't win.
 *
 * Combined: ~1500 candidates → ~30 candidates × ~8 ops average per
 * candidate (with early-out) ≈ 240 ops per match. 12K cells per frame
 * → ~3M ops, comfortably under 10ms.
 */

import { FONT_FAMILY, FONT_SIZE_PX, LINE_HEIGHT } from './constants';

export const WGW = 8;
export const WGH = 16;
export const WGAREA = WGW * WGH;
export const WMASK_WORDS = 4;

export interface WideAtlas {
	readonly chars: readonly string[];
	readonly codes: Uint16Array;
	readonly masksFlat: Uint32Array;
	readonly inks: Uint16Array;
	readonly N: number;
	readonly bucketStarts: Int32Array;
	readonly bucketIdx: Int32Array;
}

let _atlas: WideAtlas | null = null;
let _atlasBuilding = false;

// Code-point ranges to attempt. Each range is [lo, hi] inclusive. Chars
// not rendered by the active font produce an empty mask and get filtered;
// fallback-font glyphs that happen to render identical shapes get deduped
// in the hash pass. The ranges below are generously wide on purpose —
// the dedupe is cheap and there's no penalty for trying a code point.
// Ranges to attempt. We deliberately skip Misc Symbols (U+2600) and
// Dingbats (U+2700) because most of their entries render as full-width
// emoji glyphs (browser falls back to a color emoji font), and a
// double-advance glyph in a monospace grid shifts every cell after it
// horizontally. Survivors of the remaining ranges are filtered through a
// per-glyph advance-width check below as a defense-in-depth measure.
const RANGES: Array<readonly [number, number]> = [
	[0x21, 0x7e], //  Printable ASCII (excl. space, added explicitly)
	[0x00a1, 0x00ff], //  Latin Supplement
	[0x0100, 0x024f], //  Latin Extended A + B
	[0x0370, 0x03ff], //  Greek
	[0x0400, 0x04ff], //  Cyrillic
	[0x2010, 0x205f], //  General Punctuation
	[0x2070, 0x209f], //  Super/subscripts
	[0x2100, 0x214f], //  Letterlike symbols
	[0x2190, 0x21ff], //  Arrows
	[0x2200, 0x22ff], //  Mathematical Operators
	[0x2300, 0x23ff], //  Misc Technical
	[0x2500, 0x257f], //  Box Drawing
	[0x2580, 0x259f], //  Block Elements
	[0x25a0, 0x25ff], //  Geometric Shapes
	[0x27f0, 0x27ff], //  Supplemental Arrows-A
	[0x2800, 0x28ff], //  Braille (256 distinct dot patterns)
	[0x2900, 0x297f], //  Supplemental Arrows-B
	[0x29d0, 0x29ff], //  Misc Math Symbols-B
	[0x2a00, 0x2aff] //  Supplemental Math Operators
];

function popcount(n: number): number {
	n = n - ((n >>> 1) & 0x55555555);
	n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
	n = (n + (n >>> 4)) & 0x0f0f0f0f;
	return (n * 0x01010101) >>> 24;
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

// 8-bit signature: 2 cols × 4 rows of 4×4 sub-regions. Each bit = "this
// region has ≥ 8 of 16 sub-cells inked". Cheap to compute, separates the
// glyph population well across all 256 buckets.
function signature(m0: number, m1: number, m2: number, m3: number): number {
	const m = [m0, m1, m2, m3];
	let sig = 0;
	// region (rcol, rrow) covers rows [rrow*4, rrow*4+4), cols [rcol*4, rcol*4+4)
	for (let rrow = 0; rrow < 4; rrow++) {
		for (let rcol = 0; rcol < 2; rcol++) {
			let count = 0;
			for (let dy = 0; dy < 4; dy++) {
				const sy = rrow * 4 + dy;
				for (let dx = 0; dx < 4; dx++) {
					const sx = rcol * 4 + dx;
					const i = sy * WGW + sx;
					count += (m[i >>> 5] >>> (i & 31)) & 1;
				}
			}
			if (count >= 8) sig |= 1 << (rrow * 2 + rcol);
		}
	}
	return sig;
}

export function buildWideAtlas(): WideAtlas {
	if (_atlas) return _atlas;
	if (_atlasBuilding) throw new Error('wideAtlas: re-entrant build');
	_atlasBuilding = true;
	try {
		const candidates: string[] = [' '];
		for (const [lo, hi] of RANGES) {
			for (let cp = lo; cp <= hi; cp++) {
				candidates.push(String.fromCharCode(cp));
			}
		}

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
		if (!ctx) throw new Error('wideAtlas: 2d context unavailable');
		ctx.font = `${FONT_SIZE_PX * dpr * SCALE}px ${FONT_FAMILY}`;
		ctx.textBaseline = 'top';
		ctx.imageSmoothingEnabled = true;

		const THRESH = 0.3;

		// Per-glyph advance-width check. Canvas font is set in scaled px, so
		// `measureText().width` returns scaled-px advance. A monospace
		// candidate must measure to within ~5% of the standard cell width,
		// or it'd shift every following cell when rendered to the DOM.
		const expectedAdvance = cellW * dpr * SCALE;
		const advanceTol = expectedAdvance * 0.05;

		// Pass 1: rasterize, dedupe by mask hash. Different code points that
		// rasterize to the same shape (font fallbacks, zero-width invisibles,
		// near-identical visual glyphs) collapse into one atlas slot.
		const seenHashes = new Map<string, number>();
		const uniqueChars: string[] = [];
		const uniqueMasks: number[][] = [];
		const uniqueInks: number[] = [];

		// Space goes in first as glyph 0 — matchers return 0 to mean "space".
		uniqueChars.push(' ');
		uniqueMasks.push([0, 0, 0, 0]);
		uniqueInks.push(0);
		seenHashes.set('0,0,0,0', 0);

		let widthRejected = 0;
		for (const chStr of candidates) {
			if (chStr === ' ') continue;

			// Advance-width gate: emoji-style glyphs (and a few math-block
			// chars) render at ~2× monospace width via font fallback. Reject
			// before rasterizing — same-width-as-cellW or skip.
			const advance = ctx.measureText(chStr).width;
			if (Math.abs(advance - expectedAdvance) > advanceTol) {
				widthRejected++;
				continue;
			}

			ctx.fillStyle = '#000';
			ctx.fillRect(0, 0, cw, ch);
			ctx.fillStyle = '#fff';
			ctx.fillText(chStr, 0, 0);
			const data = ctx.getImageData(0, 0, cw, ch).data;

			const mask = [0, 0, 0, 0];
			let inkCount = 0;
			for (let sy = 0; sy < WGH; sy++) {
				const py0 = Math.floor((sy * ch) / WGH);
				const py1 = Math.max(py0 + 1, Math.floor(((sy + 1) * ch) / WGH));
				for (let sx = 0; sx < WGW; sx++) {
					const px0 = Math.floor((sx * cw) / WGW);
					const px1 = Math.max(px0 + 1, Math.floor(((sx + 1) * cw) / WGW));
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
						const i = sy * WGW + sx;
						mask[i >>> 5] |= 1 << (i & 31);
						inkCount++;
					}
				}
			}

			// Skip empty masks (font has no glyph at this code point).
			if (inkCount === 0) continue;

			const hash = `${mask[0]},${mask[1]},${mask[2]},${mask[3]}`;
			if (seenHashes.has(hash)) continue;
			seenHashes.set(hash, uniqueChars.length);
			uniqueChars.push(chStr);
			uniqueMasks.push(mask);
			uniqueInks.push(inkCount);
		}

		const N = uniqueChars.length;
		const masksFlat = new Uint32Array(N * WMASK_WORDS);
		const inks = new Uint16Array(N);
		const codes = new Uint16Array(N);
		for (let i = 0; i < N; i++) {
			const m = uniqueMasks[i];
			masksFlat[i * WMASK_WORDS] = m[0];
			masksFlat[i * WMASK_WORDS + 1] = m[1];
			masksFlat[i * WMASK_WORDS + 2] = m[2];
			masksFlat[i * WMASK_WORDS + 3] = m[3];
			inks[i] = uniqueInks[i];
			codes[i] = uniqueChars[i].charCodeAt(0);
		}

		// Pass 2: bucket index. Compute each glyph's 8-bit signature and
		// arrange glyph indices in a flat array sorted by bucket. Two
		// parallel arrays — `bucketStarts[b]` is the offset into `bucketIdx`
		// where bucket `b` begins; `bucketStarts[b+1]` is where it ends.
		const NBUCKETS = 256;
		const sigs = new Uint8Array(N);
		for (let i = 0; i < N; i++) {
			const off = i * WMASK_WORDS;
			sigs[i] = signature(
				masksFlat[off],
				masksFlat[off + 1],
				masksFlat[off + 2],
				masksFlat[off + 3]
			);
		}
		const bucketSizes = new Int32Array(NBUCKETS);
		for (let i = 0; i < N; i++) bucketSizes[sigs[i]]++;
		const bucketStarts = new Int32Array(NBUCKETS + 1);
		for (let b = 0; b < NBUCKETS; b++) bucketStarts[b + 1] = bucketStarts[b] + bucketSizes[b];
		const bucketIdx = new Int32Array(N);
		const head = new Int32Array(NBUCKETS);
		for (let i = 0; i < N; i++) {
			const b = sigs[i];
			bucketIdx[bucketStarts[b] + head[b]] = i;
			head[b]++;
		}

		_atlas = { chars: uniqueChars, codes, masksFlat, inks, N, bucketStarts, bucketIdx };

		if (typeof console !== 'undefined') {
			console.log(
				`[wideAtlas] ${candidates.length} candidates → ${N} unique shapes ` +
					`(${widthRejected} rejected for non-monospace advance, ` +
					`${candidates.length - widthRejected - N} deduped)`
			);
		}

		return _atlas;
	} finally {
		_atlasBuilding = false;
	}
}

// Match a 4-word target mask to the closest atlas glyph using bucket
// indexing + early-out SAD. The 4 mask words are passed as plain numbers
// (not as a typed array view) so V8 keeps them in registers across the
// inner loop.
//
// Searches the primary bucket first, then 1-bit hamming neighbors. The
// neighbor pass catches targets whose signature happens to flip a
// borderline region — without it, sub-cell-resolution rendering of
// smooth curves had visible "tier" steps where the signature crossed
// from one bucket to an adjacent one.
export function matchWide(
	t0: number,
	t1: number,
	t2: number,
	t3: number,
	atlas: WideAtlas = buildWideAtlas()
): number {
	// Target ink count — used both for the "must beat space" guard and
	// the early-out floor (a SAD ≥ tInk means the glyph contributes more
	// disagreement than the target had ink, so emit space instead).
	const tInk = popcount(t0) + popcount(t1) + popcount(t2) + popcount(t3);
	if (tInk <= 1) return 0;

	const tsig = signature(t0, t1, t2, t3);
	const { bucketStarts, bucketIdx, masksFlat, inks } = atlas;

	let bestI = 0;
	let bestSAD = 1 << 30;
	let bestInk = 1 << 30;

	// 9 buckets: primary + 8 hamming-1 neighbors. Inlined unroll lets
	// V8 keep `tsig` and the t* values in registers; no array of buckets.
	for (let neigh = 0; neigh <= 8; neigh++) {
		const sig = neigh === 0 ? tsig : tsig ^ (1 << (neigh - 1));
		const start = bucketStarts[sig];
		const end = bucketStarts[sig + 1];
		for (let p = start; p < end; p++) {
			const i = bucketIdx[p];
			const off = i * WMASK_WORDS;

			let n = (masksFlat[off] ^ t0) >>> 0;
			n = n - ((n >>> 1) & 0x55555555);
			n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
			n = (n + (n >>> 4)) & 0x0f0f0f0f;
			let sad = (n * 0x01010101) >>> 24;
			if (sad >= bestSAD) continue;

			n = (masksFlat[off + 1] ^ t1) >>> 0;
			n = n - ((n >>> 1) & 0x55555555);
			n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
			n = (n + (n >>> 4)) & 0x0f0f0f0f;
			sad += (n * 0x01010101) >>> 24;
			if (sad >= bestSAD) continue;

			n = (masksFlat[off + 2] ^ t2) >>> 0;
			n = n - ((n >>> 1) & 0x55555555);
			n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
			n = (n + (n >>> 4)) & 0x0f0f0f0f;
			sad += (n * 0x01010101) >>> 24;
			if (sad >= bestSAD) continue;

			n = (masksFlat[off + 3] ^ t3) >>> 0;
			n = n - ((n >>> 1) & 0x55555555);
			n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
			n = (n + (n >>> 4)) & 0x0f0f0f0f;
			sad += (n * 0x01010101) >>> 24;
			if (sad >= bestSAD) continue;

			const ink = inks[i];
			if (sad < bestSAD || (sad === bestSAD && ink < bestInk)) {
				bestSAD = sad;
				bestI = i;
				bestInk = ink;
			}
		}
	}

	if (bestSAD >= tInk) return 0;
	return bestI;
}

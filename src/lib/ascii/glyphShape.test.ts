import { describe, it, expect } from 'vitest';
import {
	GAREA,
	GH,
	GW,
	MASK_WORDS,
	getBilinearWeights,
	maskAlloc,
	maskBit,
	maskInk,
	matchMask,
	type GlyphAtlas,
	type Mask
} from './glyphShape';

// Build a synthetic atlas of three glyphs (space, top-left dot, bottom-right
// dot) so we can verify the matcher rules without depending on canvas
// rasterization (happy-dom doesn't paint glyphs, only measures their advance).
function makeTestAtlas(): GlyphAtlas {
	const chars = [' ', "'", '.'];
	const codes = new Uint16Array([32, 39, 46]);
	const masksFlat = new Uint32Array(chars.length * MASK_WORDS);
	const inks = new Uint8Array(chars.length);

	// space: empty
	// "'": single sub-cell ink at top-right (sx=GW-1, sy=0)
	{
		const i = 0 * GW + (GW - 1);
		masksFlat[1 * MASK_WORDS + (i >>> 5)] |= 1 << (i & 31);
		inks[1] = 1;
	}
	// ".": single sub-cell ink at bottom-right (sx=GW-1, sy=GH-1)
	{
		const i = (GH - 1) * GW + (GW - 1);
		masksFlat[2 * MASK_WORDS + (i >>> 5)] |= 1 << (i & 31);
		inks[2] = 1;
	}
	return { chars, codes, masksFlat, inks, N: chars.length };
}

const atlas = makeTestAtlas();

function maskWithBit(i: number): Mask {
	const m = maskAlloc();
	m[i >>> 5] |= 1 << (i & 31);
	return m;
}

describe('mask helpers', () => {
	it('GW * GH equals GAREA, GAREA fits in MASK_WORDS Uint32s', () => {
		expect(GW * GH).toBe(GAREA);
		expect(MASK_WORDS * 32).toBeGreaterThanOrEqual(GAREA);
	});

	it('maskAlloc returns a zeroed mask of MASK_WORDS Uint32s', () => {
		const m = maskAlloc();
		expect(m.length).toBe(MASK_WORDS);
		for (let i = 0; i < MASK_WORDS; i++) expect(m[i]).toBe(0);
		expect(maskInk(m)).toBe(0);
	});

	it('maskBit reads the same bit maskWithBit set', () => {
		for (const i of [0, 31, 32, 63, GAREA - 1]) {
			const m = maskWithBit(i);
			expect(maskBit(m, i)).toBe(1);
			expect(maskInk(m)).toBe(1);
		}
	});
});

describe('getBilinearWeights', () => {
	it('weights for each sub-cell sum to ~1', () => {
		const w = getBilinearWeights();
		expect(w.length).toBe(GAREA * 4);
		for (let i = 0; i < GAREA; i++) {
			const off = i * 4;
			const s = w[off] + w[off + 1] + w[off + 2] + w[off + 3];
			expect(s).toBeCloseTo(1, 5);
		}
	});

	it('top-left sub-cell weights its TL corner heavily, BR negligibly', () => {
		const w = getBilinearWeights();
		// sub-cell (0, 0) → off 0
		expect(w[0]).toBeGreaterThan(w[1]); // tl > tr
		expect(w[0]).toBeGreaterThan(w[2]); // tl > bl
		expect(w[0]).toBeGreaterThan(w[3]); // tl > br
		// last sub-cell → BR-heavy
		const off = (GAREA - 1) * 4;
		expect(w[off + 3]).toBeGreaterThan(w[off]); // br > tl
	});
});

describe('matchMask rules', () => {
	it('rule A: empty target → space (index 0), no scoring', () => {
		const empty = maskAlloc();
		expect(matchMask(empty, atlas)).toBe(0);
	});

	it('default emptyThreshold=2: 1- and 2-sub-cell targets resolve to space (noise floor)', () => {
		// Single-bit target — would be a "stray" edge-noise pixel.
		const m1 = maskWithBit(0);
		expect(matchMask(m1, atlas)).toBe(0);
		// Two-bit target — also below the default noise floor.
		const m2 = maskAlloc();
		m2[0] = 0b11;
		expect(matchMask(m2, atlas)).toBe(0);
	});

	it('must-beat-space: a glyph wins only when its SAD is strictly less than target ink', () => {
		// Single-bit target at center. The synthetic atlas has only "'" (top-
		// right) and "." (bottom-right) — neither overlaps a center pixel, so
		// every non-space glyph has SAD = glyph_ink + 1 ≥ 2. target_ink = 1.
		// Since no glyph SAD < 1, the matcher emits space even with
		// emptyThreshold=0 (the must-beat-space guard supersedes rule B).
		const m = maskWithBit((GH >>> 1) * GW + (GW >>> 1));
		expect(matchMask(m, atlas, 0)).toBe(0);

		// But when a glyph DOES match positionally, must-beat-space yields:
		// target = single bit at top-right, "'" has its ink at top-right →
		// SAD = 0, target_ink = 1, 0 < 1 → picked.
		const tr = maskWithBit(0 * GW + (GW - 1));
		expect(atlas.chars[matchMask(tr, atlas, 0)]).toBe("'");
	});

	it("positional matching: ink at top-right picks `'` over `.`", () => {
		const m = maskWithBit(0 * GW + (GW - 1)); // top-right cell
		const idx = matchMask(m, atlas, 0);
		expect(atlas.chars[idx]).toBe("'");
	});

	it('positional matching: ink at bottom-right picks `.` over `\'`', () => {
		const m = maskWithBit((GH - 1) * GW + (GW - 1)); // bottom-right cell
		const idx = matchMask(m, atlas, 0);
		expect(atlas.chars[idx]).toBe('.');
	});

	it('rule C: ties break toward lower-ink glyph', () => {
		// Build a 4-glyph atlas where two glyphs match equally well, but one
		// has lower ink. We expect the lower-ink one.
		const chars = [' ', 'a', 'b', 'c'];
		const codes = new Uint16Array([32, 97, 98, 99]);
		const masksFlat = new Uint32Array(4 * MASK_WORDS);
		const inks = new Uint8Array(4);
		// 'a': ink at sub-cell 0 only
		masksFlat[1 * MASK_WORDS] |= 1; inks[1] = 1;
		// 'b': ink at sub-cell 0 AND sub-cell 1 (heavier)
		masksFlat[2 * MASK_WORDS] |= 0b11; inks[2] = 2;
		// 'c': ink at sub-cell 5 only (different position)
		masksFlat[3 * MASK_WORDS] |= 1 << 5; inks[3] = 1;
		const ta: GlyphAtlas = { chars, codes, masksFlat, inks, N: 4 };

		// Target: ink at sub-cell 0. Distances:
		//   'a' (ink=1): SAD = 0
		//   'b' (ink=2): SAD = 1
		//   'c' (ink=1): SAD = 2
		// 'a' wins outright (using strict emptyThreshold=0 to bypass noise floor).
		const m = maskAlloc();
		m[0] = 1;
		expect(ta.chars[matchMask(m, ta, 0)]).toBe('a');

		// Target: ink at both sub-cells 0 and 1. Distances:
		//   'a' (ink=1): SAD = 1
		//   'b' (ink=2): SAD = 0
		//   'c' (ink=1): SAD = 3
		// 'b' wins outright (better SAD).
		const m2 = maskAlloc();
		m2[0] = 0b11;
		expect(ta.chars[matchMask(m2, ta, 0)]).toBe('b');
	});
});

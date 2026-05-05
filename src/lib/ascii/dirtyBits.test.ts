import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, type Harness } from './testHelpers';

// Each mutator must flip `dirtyRows[j] = 1` for every row it writes into —
// otherwise `renderToDOM()` will skip that row and the write is invisible
// until someone *else* dirties the row. These tests lock in that contract:
// after calling a mutator, the rows it touched must show updated DOM content
// and the rows it didn't touch must be byte-identical.
//
// The test trick: the render path only rewrites a row when the dirty bit is
// flipped AND the back-buffer differs. The buffer *will* differ (we write new
// chars), so the only reason a row could fail to repaint is a missing dirty
// flag. "Row text changed" is therefore a proxy for "dirty bit was flipped."

let h: Harness | null = null;
afterEach(() => {
	h?.cleanup();
	h = null;
});

function rowStrings(h: Harness): string[] {
	const out: string[] = [];
	for (let j = 0; j < h.api.rows; j++) out.push(h.row(j).textContent ?? '');
	return out;
}

/**
 * Assert that exactly the rows in `expected` changed between `before` and
 * `after`. Fails loudly if a row that shouldn't have moved did move (stale
 * state / over-dirtying) or a row that should have moved didn't (missing
 * dirty flag).
 */
function expectChangedRows(before: string[], after: string[], expected: number[]) {
	const set = new Set(expected);
	for (let j = 0; j < before.length; j++) {
		if (set.has(j)) {
			expect(after[j], `row ${j} should have changed`).not.toBe(before[j]);
		} else {
			expect(after[j], `row ${j} should NOT have changed`).toBe(before[j]);
		}
	}
}

describe('dirty-bit coverage — direct mutators', () => {
	it('api.set flips only the written row', () => {
		h = makeHarness(10, 5);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) => c.set(3, 2, 'Z'));
		expectChangedRows(before, rowStrings(h), [2]);
	});

	it('api.fill flips every row', () => {
		h = makeHarness(10, 5);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) => c.fill('.'));
		expectChangedRows(before, rowStrings(h), [0, 1, 2, 3, 4]);
	});

	it('api.clear flips every row (delegates to fill)', () => {
		h = makeHarness(10, 5);
		// Put something in every row so clearing will be observable.
		h.frame((c) => c.fill('X'));
		const before = rowStrings(h);
		h.frame((c) => c.clear());
		expectChangedRows(before, rowStrings(h), [0, 1, 2, 3, 4]);
	});

	it('api.fillRect flips rows y0..y1-1', () => {
		h = makeHarness(10, 6);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) => c.fillRect(2, 1, 5, 3, '#'));
		expectChangedRows(before, rowStrings(h), [1, 2, 3]);
	});

	it('api.fillCircle flips only the rows the circle covers', () => {
		h = makeHarness(16, 10);
		h.frame();
		const before = rowStrings(h);
		// radius 2 at (cx=8, cy=5) with cellAspect ≈ cellH/cellW = 16/8 = 2,
		// so rowSpan = r / aspect = 1 → rows 4..6.
		h.frame((c) => c.fillCircle(8, 5, 2, '*'));
		const after = rowStrings(h);
		// Find which rows actually changed; assert it's a contiguous subset
		// around cy and doesn't include far-away rows.
		const changed: number[] = [];
		for (let j = 0; j < h.api.rows; j++) if (after[j] !== before[j]) changed.push(j);
		expect(changed.length).toBeGreaterThan(0);
		for (const j of changed) expect(Math.abs(j - 5)).toBeLessThanOrEqual(2);
	});

	it('api.field flips every row', () => {
		h = makeHarness(10, 5);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) => c.field(() => 0.5));
		expectChangedRows(before, rowStrings(h), [0, 1, 2, 3, 4]);
	});

	it('api.fieldRect flips only its y-range', () => {
		h = makeHarness(10, 6);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) => c.fieldRect(0, 2, 10, 2, () => 0.7));
		expectChangedRows(before, rowStrings(h), [2, 3]);
	});

	it('api.dither (threshold) flips only its y-range', () => {
		h = makeHarness(10, 6);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) =>
			c.dither(() => 0.8, { type: 'threshold', rect: { x: 0, y: 1, w: 10, h: 3 } })
		);
		expectChangedRows(before, rowStrings(h), [1, 2, 3]);
	});

	it('api.dither (ordered) flips only its y-range', () => {
		h = makeHarness(10, 6);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) =>
			c.dither((x, y) => (x + y) * 0.05, {
				type: 'ordered',
				rect: { x: 0, y: 2, w: 10, h: 2 }
			})
		);
		expectChangedRows(before, rowStrings(h), [2, 3]);
	});

	it('api.dither (floyd-steinberg) flips only its y-range', () => {
		h = makeHarness(10, 6);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) =>
			c.dither((x) => x * 0.1, {
				type: 'floyd-steinberg',
				rect: { x: 0, y: 1, w: 10, h: 2 }
			})
		);
		expectChangedRows(before, rowStrings(h), [1, 2]);
	});

	it('api.bset flips only the braille cell row (py >> 2)', () => {
		h = makeHarness(10, 5);
		h.frame();
		const before = rowStrings(h);
		// px=6, py=9 → cell (3, 2).
		h.frame((c) => c.bset(6, 9));
		expectChangedRows(before, rowStrings(h), [2]);
	});

	it('api.bclear flips only rows that contained braille cells', () => {
		h = makeHarness(10, 5);
		// Put a braille dot in row 1 only.
		h.frame((c) => c.bset(2, 5)); // py=5 → row 1
		const before = rowStrings(h);
		h.frame((c) => c.bclear());
		expectChangedRows(before, rowStrings(h), [1]);
	});
});

describe('dirty-bit coverage — mutators that delegate via api.set', () => {
	it('api.line', () => {
		h = makeHarness(10, 5);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) => c.line(1, 1, 8, 3, '*'));
		expectChangedRows(before, rowStrings(h), [1, 2, 3]);
	});

	it('api.strokeRect', () => {
		h = makeHarness(10, 6);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) => c.strokeRect(1, 1, 6, 4, '#'));
		// Top + bottom + verticals → rows 1..4.
		expectChangedRows(before, rowStrings(h), [1, 2, 3, 4]);
	});

	it('api.circle', () => {
		h = makeHarness(16, 10);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) => c.circle(8, 5, 3, 'o'));
		const after = rowStrings(h);
		const changed: number[] = [];
		for (let j = 0; j < h.api.rows; j++) if (after[j] !== before[j]) changed.push(j);
		// Midpoint circle of radius 3 at cy=5 touches rows 2..8 (including
		// the horizontal diameter at cy=5 from the first iteration).
		expect(changed).toEqual([2, 3, 4, 5, 6, 7, 8]);
	});

	it('api.border', () => {
		h = makeHarness(10, 6);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) => c.border(1, 1, 6, 4, 'single'));
		expectChangedRows(before, rowStrings(h), [1, 2, 3, 4]);
	});

	it('api.text', () => {
		h = makeHarness(10, 5);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) => c.text(0, 2, 'hello'));
		expectChangedRows(before, rowStrings(h), [2]);
	});

	it('api.textBox (with wrap) flips each content row it writes', () => {
		h = makeHarness(14, 8);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) =>
			c.textBox(1, 1, 12, 6, 'lorem ipsum dolor sit amet', {
				wrap: 'word',
				border: true
			})
		);
		const after = rowStrings(h);
		const changed: number[] = [];
		for (let j = 0; j < h.api.rows; j++) if (after[j] !== before[j]) changed.push(j);
		// Box spans rows 1..6; row 0 and 7 must be untouched.
		expect(changed.length).toBeGreaterThan(0);
		for (const j of changed) {
			expect(j).toBeGreaterThanOrEqual(1);
			expect(j).toBeLessThanOrEqual(6);
		}
	});

	it('api.contour', () => {
		h = makeHarness(16, 10);
		h.frame();
		const before = rowStrings(h);
		// A field crossing 0 roughly along y=5: marching squares will emit
		// chars in rows near the crossing.
		h.frame((c) => c.contour((x, y) => y - 5, 0));
		const after = rowStrings(h);
		const changed: number[] = [];
		for (let j = 0; j < h.api.rows; j++) if (after[j] !== before[j]) changed.push(j);
		expect(changed.length).toBeGreaterThan(0);
		for (const j of changed) expect(Math.abs(j - 4.5)).toBeLessThanOrEqual(1.5);
	});

	it('api.bline', () => {
		h = makeHarness(10, 5);
		h.frame();
		const before = rowStrings(h);
		// Subpixel line from (2,1) to (16,13): rows 1/4 and 13/4 → cell rows 0..3.
		h.frame((c) => c.bline(2, 1, 16, 13));
		const after = rowStrings(h);
		const changed: number[] = [];
		for (let j = 0; j < h.api.rows; j++) if (after[j] !== before[j]) changed.push(j);
		expect(changed.length).toBeGreaterThan(0);
		expect(changed.every((j) => j >= 0 && j <= 3)).toBe(true);
	});

	it('api.bcircle', () => {
		h = makeHarness(16, 10);
		h.frame();
		const before = rowStrings(h);
		h.frame((c) => c.bcircle(16, 20, 6));
		const after = rowStrings(h);
		const changed: number[] = [];
		for (let j = 0; j < h.api.rows; j++) if (after[j] !== before[j]) changed.push(j);
		expect(changed.length).toBeGreaterThan(0);
	});
});

import { bench, describe } from 'vitest';
import { makeHarness } from './testHelpers';

// Stress the lazy palette interner via api.color. The interesting axis is
// palette size: Map.get cost scales sublinearly but is real.

describe('palette colorIdx growth', () => {
	bench('hot path: 1000 cached lookups (palette pre-warmed)', () => {
		const h = makeHarness(40, 12);
		const colors = Array.from({ length: 32 }, (_, i) => `#${i.toString(16).padStart(6, '0')}`);
		for (const s of colors) h.api.color(s);
		for (let i = 0; i < 1000; i++) h.api.color(colors[i & 31]);
		h.cleanup();
	});

	bench('cold path: 1000 fresh strings (palette grows)', () => {
		const h = makeHarness(40, 12);
		for (let i = 0; i < 1000; i++) {
			h.api.color(`#${(i * 1234567 & 0xffffff).toString(16).padStart(6, '0')}`);
		}
		h.cleanup();
	});
});

describe('per-cell setter overhead', () => {
	bench('set() with default colors (two Map.get per call)', () => {
		const h = makeHarness(80, 24);
		h.frame((c) => {
			for (let y = 0; y < c.rows; y++)
				for (let x = 0; x < c.cols; x++) c.set(x, y, '#');
		});
		h.cleanup();
	});

	bench('setI() with pre-resolved indices', () => {
		const h = makeHarness(80, 24);
		h.frame((c) => {
			for (let y = 0; y < c.rows; y++)
				for (let x = 0; x < c.cols; x++) c.setI(x, y, 0x23, 0, 1);
		});
		h.cleanup();
	});

	bench('blit() of pre-built buffers', () => {
		const h = makeHarness(80, 24);
		const size = 80 * 24;
		const ch = new Uint16Array(size).fill(0x23);
		const fg = new Uint16Array(size);
		const bg = new Uint16Array(size).fill(1);
		h.frame((c) => c.blit(ch, fg, bg));
		h.cleanup();
	});
});

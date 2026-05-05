import { bench, describe } from 'vitest';
import { makeHarness } from './testHelpers';

// Dither variants per frame. Floyd-Steinberg also allocates a Float32Array
// per call, which the bench captures implicitly via the Vitest measurement.

describe('dither variants on 80×24', () => {
	const fn = (x: number, y: number) =>
		(Math.sin(x * 0.18) + Math.cos(y * 0.21)) * 0.25 + 0.5;

	bench('threshold', () => {
		const h = makeHarness(80, 24);
		h.frame((c) => c.dither(fn, { type: 'threshold' }));
		h.cleanup();
	});

	bench('ordered bayer 4', () => {
		const h = makeHarness(80, 24);
		h.frame((c) => c.dither(fn, { type: 'ordered', bayerSize: 4 }));
		h.cleanup();
	});

	bench('ordered bayer 8', () => {
		const h = makeHarness(80, 24);
		h.frame((c) => c.dither(fn, { type: 'ordered', bayerSize: 8 }));
		h.cleanup();
	});

	bench('floyd-steinberg', () => {
		const h = makeHarness(80, 24);
		h.frame((c) => c.dither(fn, { type: 'floyd-steinberg' }));
		h.cleanup();
	});

	bench('floyd-steinberg, no serpentine', () => {
		const h = makeHarness(80, 24);
		h.frame((c) => c.dither(fn, { type: 'floyd-steinberg', serpentine: false }));
		h.cleanup();
	});
});

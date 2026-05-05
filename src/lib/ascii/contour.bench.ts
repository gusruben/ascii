import { bench, describe } from 'vitest';
import { makeHarness } from './testHelpers';

// Contour cost scales with levels × cells × 4 (corner samples). The fn
// closure is invoked once per corner per level — confirms the closure call
// rate is the bottleneck if these scale linearly with level count.

describe('contour at varying level counts', () => {
	const fn = (x: number, y: number) =>
		(Math.sin(x * 0.12) + Math.cos(y * 0.15)) * 0.25 + 0.5;

	for (const n of [1, 5, 10, 20]) {
		const levels = Array.from({ length: n }, (_, i) => (i + 0.5) / n);
		bench(`${n} levels on 80×24`, () => {
			const h = makeHarness(80, 24);
			h.frame((c) => c.contour(fn, levels));
			h.cleanup();
		});
	}
});

import { bench, describe } from 'vitest';
import { makeHarness } from './testHelpers';

// textBox layout (word-wrap, padding, border, ellipsis) runs every call —
// it does not cache the wrapped lines. A 4×4 grid of textBoxes redrawn
// every frame is plausible (HUD, debug overlays).

const TEXT =
	'The cost of word-wrap inside textBox is paid every frame because the wrap ' +
	'result is not cached. Long enough text forces multiple line splits.';

describe('textBox throughput', () => {
	bench('1× textBox no border, no padding, char wrap', () => {
		const h = makeHarness(80, 24);
		h.frame((c) => c.textBox(0, 0, 80, 24, TEXT, { wrap: 'char' }));
		h.cleanup();
	});

	bench('1× textBox border + padding + word wrap', () => {
		const h = makeHarness(80, 24);
		h.frame((c) =>
			c.textBox(0, 0, 80, 24, TEXT, {
				border: 'rounded', padding: 1, wrap: 'word', overflow: 'ellipsis'
			})
		);
		h.cleanup();
	});

	bench('16× small textBoxes (4×4 grid) with shadow', () => {
		const h = makeHarness(80, 24);
		h.frame((c) => {
			for (let gy = 0; gy < 4; gy++) {
				for (let gx = 0; gx < 4; gx++) {
					c.textBox(gx * 20, gy * 6, 19, 5, TEXT, {
						border: 'rounded', padding: { x: 1, y: 0 }, shadow: '#222', wrap: 'word'
					});
				}
			}
		});
		h.cleanup();
	});
});

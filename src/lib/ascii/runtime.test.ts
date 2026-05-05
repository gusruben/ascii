import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, type Harness } from './testHelpers';
import { DEFAULT_FG, DEFAULT_BG } from './constants';

let h: Harness | null = null;
afterEach(() => {
	h?.cleanup();
	h = null;
});

describe('runtime grid setup', () => {
	it('picks cols/rows from the wrap element size', () => {
		h = makeHarness(10, 4);
		expect(h.api.cols).toBe(10);
		expect(h.api.rows).toBe(4);
	});

	it('creates one row element per grid row', () => {
		h = makeHarness(10, 4);
		expect(h.pre.childNodes.length).toBe(4);
	});

	it('clamps to at least 4×4', () => {
		h = makeHarness(2, 2);
		expect(h.api.cols).toBeGreaterThanOrEqual(4);
		expect(h.api.rows).toBeGreaterThanOrEqual(4);
	});
});

describe('text path (default fg/bg)', () => {
	it('writes a single Text node, no <span> children', () => {
		h = makeHarness(10, 2);
		h.frame((c) => {
			c.text(0, 0, 'HELLO');
		});
		const row0 = h.row(0);
		expect(row0.querySelectorAll('span').length).toBe(0);
		expect(row0.textContent).toBe('HELLO     ');
	});

	it('does not set inline style.color / background for default colors', () => {
		h = makeHarness(10, 2);
		h.frame((c) => c.text(0, 0, 'x'));
		const row0 = h.row(0);
		expect(row0.style.color).toBe('');
		expect(row0.style.background).toBe('');
	});

	it('reuses the same Text node across frames (no reallocation)', () => {
		h = makeHarness(10, 2);
		h.frame((c) => c.text(0, 0, 'AAA'));
		const textNode1 = h.row(0).firstChild;
		h.frame((c) => c.text(0, 0, 'BBB'));
		const textNode2 = h.row(0).firstChild;
		expect(textNode1).toBe(textNode2);
		expect(h.row(0).textContent).toBe('BBB       ');
	});
});

describe('uniform path (whole row shares one non-default color)', () => {
	it('sets style.color once on the row element, emits no spans', () => {
		h = makeHarness(10, 2);
		h.frame((c) => {
			c.fillRect(0, 0, 10, 1, 'X', '#ff0000', DEFAULT_BG);
		});
		const row0 = h.row(0);
		expect(row0.querySelectorAll('span').length).toBe(0);
		// Browsers serialize colors differently; any of these are acceptable.
		const color = row0.style.color;
		expect(color === '#ff0000' || color === 'rgb(255, 0, 0)' || color === 'red').toBe(true);
		expect(row0.textContent).toBe('XXXXXXXXXX');
	});

	it('reuses the text node when switching colors uniformly (no DOM reshape)', () => {
		h = makeHarness(10, 2);
		h.frame((c) => c.fillRect(0, 0, 10, 1, 'X', '#ff0000'));
		const t1 = h.row(0).firstChild;
		h.frame((c) => c.fillRect(0, 0, 10, 1, 'Y', '#00ff00'));
		const t2 = h.row(0).firstChild;
		expect(t1).toBe(t2);
	});
});

describe('mixed / html path (colors vary across the row)', () => {
	it('emits <span> runs with inline styles and escapes HTML entities', () => {
		h = makeHarness(10, 2);
		h.frame((c) => {
			c.set(0, 0, '<', '#ff0000');
			c.set(1, 0, '>', '#00ff00');
			c.set(2, 0, '&', '#0000ff');
		});
		const row0 = h.row(0);
		expect(row0.querySelectorAll('span').length).toBeGreaterThan(0);
		const html = row0.innerHTML;
		expect(html).toContain('&lt;');
		expect(html).toContain('&gt;');
		expect(html).toContain('&amp;');
		// The three colored cells must not share a span since their colors differ.
		expect(row0.querySelectorAll('span').length).toBeGreaterThanOrEqual(3);
	});

	it('coalesces consecutive cells with identical styling into one span', () => {
		h = makeHarness(10, 2);
		h.frame((c) => {
			c.set(0, 0, 'A', '#ff0000');
			c.set(1, 0, 'B', '#ff0000');
			c.set(2, 0, 'C', '#ff0000');
			c.set(3, 0, 'D', '#00ff00'); // force "mixed" mode, different color
		});
		const row0 = h.row(0);
		// A/B/C share style → one span; D → another span. 2 spans total.
		expect(row0.querySelectorAll('span').length).toBe(2);
		const firstSpan = row0.querySelectorAll('span')[0] as HTMLElement;
		expect(firstSpan.textContent).toBe('ABC');
	});
});

describe('row path transitions tear down prior state', () => {
	it('uniform → default: clears row style.color', () => {
		h = makeHarness(10, 2);
		h.frame((c) => c.fillRect(0, 0, 10, 1, 'X', '#ff0000'));
		expect(h.row(0).style.color).not.toBe('');

		h.frame((c) => {
			c.clear();
			c.text(0, 0, 'plain');
		});
		expect(h.row(0).style.color).toBe('');
		expect(h.row(0).querySelectorAll('span').length).toBe(0);
	});

	it('mixed → text: replaces spans with a single Text node', () => {
		h = makeHarness(10, 2);
		h.frame((c) => {
			c.set(0, 0, 'A', '#ff0000');
			c.set(1, 0, 'B', '#00ff00');
		});
		expect(h.row(0).querySelectorAll('span').length).toBeGreaterThan(0);

		h.frame((c) => {
			c.clear();
			c.text(0, 0, 'plain');
		});
		const row0 = h.row(0);
		expect(row0.querySelectorAll('span').length).toBe(0);
		expect(row0.firstChild?.nodeType).toBe(3 /* TEXT_NODE */);
		expect(row0.textContent).toBe('plain     ');
	});

	it('uniform → mixed: clears the uniform style before emitting spans', () => {
		h = makeHarness(10, 2);
		h.frame((c) => c.fillRect(0, 0, 10, 1, 'X', '#ff0000'));
		expect(h.row(0).style.color).not.toBe('');

		h.frame((c) => {
			c.clear();
			c.set(0, 0, 'A', '#ff0000');
			c.set(1, 0, 'B', '#00ff00');
		});
		// Inline style.color must be cleared so per-span colors aren't layered
		// on top of a row-wide color.
		expect(h.row(0).style.color).toBe('');
		expect(h.row(0).querySelectorAll('span').length).toBeGreaterThan(0);
	});
});

describe('dirty-row bitmap', () => {
	it('skips re-rendering rows that were not written', () => {
		h = makeHarness(10, 3);
		h.frame((c) => c.text(0, 1, 'middle'));

		// Hold a reference to row 0's text node. If row 0 isn't dirty on the
		// next frame, the node must be the same identity (no teardown).
		const row0 = h.row(0);
		const t1 = row0.firstChild;
		h.frame((c) => c.text(0, 1, 'middle2'));
		const t2 = row0.firstChild;
		expect(t1).toBe(t2);
	});

	it('re-renders a row after api.set touches it', () => {
		h = makeHarness(10, 3);
		h.frame(); // initial clear frame
		h.frame((c) => c.set(0, 2, 'Z'));
		expect(h.row(2).textContent?.[0]).toBe('Z');
	});
});

describe('api.get / api.set round trip', () => {
	it('round-trips char and colors through the SoA buffer', () => {
		h = makeHarness(10, 2);
		h.frame((c) => c.set(3, 1, 'Q', '#abcdef', '#123456'));
		let seen: { char: string; fg: string; bg: string } | null = null;
		h.frame((c) => {
			const v = c.get(3, 1);
			if (v) seen = { char: v.char, fg: v.fg, bg: v.bg };
		});
		expect(seen).toEqual({ char: 'Q', fg: '#abcdef', bg: '#123456' });
	});

	it('returns null for out-of-bounds reads', () => {
		h = makeHarness(10, 2);
		let v: unknown = undefined;
		h.frame((c) => {
			v = c.get(-1, 0);
		});
		expect(v).toBeNull();
	});
});

describe('boundary checks', () => {
	it('api.set silently ignores out-of-bounds writes', () => {
		h = makeHarness(10, 2);
		h.frame((c) => {
			c.set(-1, 0, 'X');
			c.set(0, -1, 'X');
			c.set(100, 0, 'X');
			c.set(0, 100, 'X');
			c.text(0, 0, 'ok');
		});
		expect(h.row(0).textContent).toBe('ok        ');
	});
});

describe('default fill state', () => {
	it('initializes the grid with spaces on default fg/bg', () => {
		h = makeHarness(10, 2);
		// The constructor's resize() already ran effect + renderToDOM once
		// with a no-op effect, so every row should be blank defaults.
		for (let j = 0; j < 2; j++) {
			const row = h.row(j);
			expect(row.style.color).toBe('');
			expect(row.style.background).toBe('');
			expect(row.textContent).toBe('          ');
		}
	});
});

// Silence the one-time first-frame console.log that the runtime emits.
// It fires from a requestAnimationFrame scheduled inside tick(), so it only
// prints if a second frame is flushed after the first. Harmless, but noisy.
void DEFAULT_FG;

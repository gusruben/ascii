import { describe, it, expect } from 'vitest';
import { rgb, hsl, lerpColor, rampChar, rampCodes } from './colors';

describe('rgb', () => {
	it('formats as stable lowercase #rrggbb', () => {
		expect(rgb(0, 0, 0)).toBe('#000000');
		expect(rgb(255, 255, 255)).toBe('#ffffff');
		expect(rgb(1, 2, 3)).toBe('#010203');
	});

	it('clamps out-of-range channels', () => {
		expect(rgb(-10, 0, 0)).toBe('#000000');
		expect(rgb(0, 999, 0)).toBe('#00ff00');
		expect(rgb(300, -5, 128)).toBe('#ff0080');
	});

	it('truncates fractional channels via bitwise-or', () => {
		// `n | 0` truncates toward zero, not rounds.
		expect(rgb(127.9, 127.9, 127.9)).toBe('#7f7f7f');
	});

	it('is stable: identical inputs produce identical strings (palette-friendly)', () => {
		const a = rgb(42, 84, 168);
		const b = rgb(42, 84, 168);
		expect(a).toBe(b);
	});
});

describe('hsl', () => {
	it('produces stable #rrggbb strings', () => {
		expect(hsl(0, 1, 0.5)).toBe('#ff0000');
		expect(hsl(120, 1, 0.5)).toBe('#00ff00');
		expect(hsl(240, 1, 0.5)).toBe('#0000ff');
	});

	it('wraps hue modulo 360', () => {
		expect(hsl(360, 1, 0.5)).toBe(hsl(0, 1, 0.5));
		expect(hsl(720, 1, 0.5)).toBe(hsl(0, 1, 0.5));
		expect(hsl(-120, 1, 0.5)).toBe(hsl(240, 1, 0.5));
	});

	it('clamps saturation and lightness into [0,1]', () => {
		expect(hsl(180, -1, 0.5)).toBe(hsl(180, 0, 0.5));
		expect(hsl(180, 2, 0.5)).toBe(hsl(180, 1, 0.5));
		expect(hsl(180, 1, -0.5)).toBe('#000000');
		expect(hsl(180, 1, 1.5)).toBe('#ffffff');
	});

	it('maps l=0 to black and l=1 to white regardless of h/s', () => {
		expect(hsl(42, 0.7, 0)).toBe('#000000');
		expect(hsl(42, 0.7, 1)).toBe('#ffffff');
	});

	it('produces deterministic output for palette interning', () => {
		// This is the critical property: the palette is keyed on the output
		// string, so hsl(h, s, l) must be a pure function.
		const seen = new Set<string>();
		for (let i = 0; i < 10; i++) seen.add(hsl(37.5, 0.3, 0.42));
		expect(seen.size).toBe(1);
	});
});

describe('lerpColor', () => {
	it('returns the endpoints at t=0 and t=1', () => {
		expect(lerpColor('#000000', '#ffffff', 0)).toBe('#000000');
		expect(lerpColor('#000000', '#ffffff', 1)).toBe('#ffffff');
	});

	it('interpolates linearly at t=0.5', () => {
		expect(lerpColor('#000000', '#ffffff', 0.5)).toBe('#7f7f7f');
	});

	it('accepts short-hex inputs', () => {
		expect(lerpColor('#000', '#fff', 1)).toBe('#ffffff');
		expect(lerpColor('#f00', '#00f', 0)).toBe('#ff0000');
	});
});

describe('rampChar', () => {
	it('returns the first char at t=0 and last char at t=1', () => {
		expect(rampChar(0, 'abcd')).toBe('a');
		expect(rampChar(1, 'abcd')).toBe('d');
	});

	it('clamps out-of-range t', () => {
		expect(rampChar(-5, 'abcd')).toBe('a');
		expect(rampChar(10, 'abcd')).toBe('d');
	});

	it('indexes via truncation, never off-the-end', () => {
		const ramp = 'abcd';
		// t in [0, 1) should map to [0, ramp.length - 1]; t === 1 to last.
		for (let i = 0; i < 100; i++) {
			const t = i / 99;
			const ch = rampChar(t, ramp);
			expect(ramp.includes(ch)).toBe(true);
		}
	});
});

describe('rampCodes', () => {
	it('returns charCodes in order', () => {
		const codes = rampCodes('ab');
		expect(codes.length).toBe(2);
		expect(codes[0]).toBe('a'.charCodeAt(0));
		expect(codes[1]).toBe('b'.charCodeAt(0));
	});

	it('caches by string identity (same Uint16Array reference)', () => {
		const a = rampCodes('xyz');
		const b = rampCodes('xyz');
		expect(a).toBe(b);
	});
});

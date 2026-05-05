import { bench, describe } from 'vitest';
import { rgb, hsl, rgbQ, hslQ, lerpColor, rampChar, rampCodes } from './colors';

// All callers go through these for animated color math; they sit on every
// hot per-cell loop that varies color. Vitest reports ops/sec.

describe('rgb / hsl raw throughput', () => {
	bench('rgb(r,g,b)', () => {
		for (let i = 0; i < 1000; i++) rgb(i & 255, (i * 3) & 255, (i * 7) & 255);
	});
	bench('hsl(h,s,l)', () => {
		for (let i = 0; i < 1000; i++) hsl(i, 0.5, 0.5);
	});
	bench('rgbQ default bins=16', () => {
		for (let i = 0; i < 1000; i++) rgbQ(i & 255, (i * 3) & 255, (i * 7) & 255);
	});
	bench('hslQ default bins=16', () => {
		for (let i = 0; i < 1000; i++) hslQ(i, 0.5, 0.5);
	});
});

describe('lerpColor', () => {
	bench('lerpColor 1000 t-values (per-frame storm)', () => {
		for (let i = 0; i < 1000; i++) lerpColor('#ff3344', '#3366ff', i / 1000);
	});
});

describe('ramp helpers', () => {
	const RAMP = ' .:-=+*#%@';
	bench('rampChar 1000 t-values', () => {
		let acc = '';
		for (let i = 0; i < 1000; i++) acc = rampChar(i / 1000, RAMP);
		if (acc === 'X') console.log('sink');
	});
	bench('rampCodes (cached)', () => {
		for (let i = 0; i < 1000; i++) rampCodes(RAMP);
	});
});

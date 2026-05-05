// All three color builders produce stable #rrggbb strings — identical logical
// inputs return identical strings, so the palette stays bounded across animated
// color math. Keep callers away from string-interpolated hsl()/rgb() that
// would otherwise grow the palette indefinitely.

function hexByte(n: number): string {
	n = n | 0;
	if (n < 0) n = 0;
	else if (n > 255) n = 255;
	return (n < 16 ? '0' : '') + n.toString(16);
}

export function rgb(r: number, g: number, b: number): string {
	return '#' + hexByte(r) + hexByte(g) + hexByte(b);
}

let hslRangeWarned = false;
export function hsl(h: number, s: number, l: number): string {
	h = ((h % 360) + 360) % 360;
	if (!hslRangeWarned && (s > 1 || l > 1)) {
		hslRangeWarned = true;
		// eslint-disable-next-line no-console
		console.warn(
			`[ascii] hsl(h, s, l) expects s/l in 0..1 (not 0..100). Got s=${s}, l=${l}; clamping to 1. ` +
			'Values look CSS-shaped — divide by 100.'
		);
	}
	s = s < 0 ? 0 : s > 1 ? 1 : s;
	l = l < 0 ? 0 : l > 1 ? 1 : l;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = h / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r = 0, g = 0, b = 0;
	if (hp < 1) { r = c; g = x; }
	else if (hp < 2) { r = x; g = c; }
	else if (hp < 3) { g = c; b = x; }
	else if (hp < 4) { g = x; b = c; }
	else if (hp < 5) { r = x; b = c; }
	else { r = c; b = x; }
	const m = l - c / 2;
	return rgb(
		Math.round((r + m) * 255),
		Math.round((g + m) * 255),
		Math.round((b + m) * 255)
	);
}

// Quantized variants: round inputs to `bins` steps so animated color math can't
// explode the palette Map. `hslQ(h, s, l)` with default bins=16 bounds the
// palette at ≤ 16³ distinct strings regardless of how the caller animates h/s/l.
export function hslQ(h: number, s: number, l: number, bins = 16): string {
	const q = (v: number) => Math.round(v * bins) / bins;
	return hsl(q((((h % 360) + 360) % 360) / 360) * 360, q(s), q(l));
}

export function rgbQ(r: number, g: number, b: number, bins = 16): string {
	const step = 255 / bins;
	return rgb(Math.round(r / step) * step, Math.round(g / step) * step, Math.round(b / step) * step);
}

const hexParseCache = new Map<string, [number, number, number]>();
function parseHex(h: string): [number, number, number] {
	let v = hexParseCache.get(h);
	if (v) return v;
	let r = 0, g = 0, b = 0;
	if (h.charCodeAt(0) === 35 /* # */) {
		if (h.length === 4) {
			r = parseInt(h[1] + h[1], 16);
			g = parseInt(h[2] + h[2], 16);
			b = parseInt(h[3] + h[3], 16);
		} else if (h.length === 7) {
			r = parseInt(h.slice(1, 3), 16);
			g = parseInt(h.slice(3, 5), 16);
			b = parseInt(h.slice(5, 7), 16);
		}
	}
	v = [r, g, b];
	hexParseCache.set(h, v);
	return v;
}

export function lerpColor(a: string, b: string, t: number): string {
	const pa = parseHex(a);
	const pb = parseHex(b);
	return rgb(
		pa[0] + (pb[0] - pa[0]) * t,
		pa[1] + (pb[1] - pa[1]) * t,
		pa[2] + (pb[2] - pa[2]) * t
	);
}

const rampCodeCache = new Map<string, Uint16Array>();
export function rampCodes(ramp: string): Uint16Array {
	let v = rampCodeCache.get(ramp);
	if (v) return v;
	v = new Uint16Array(ramp.length);
	for (let i = 0; i < ramp.length; i++) v[i] = ramp.charCodeAt(i);
	rampCodeCache.set(ramp, v);
	return v;
}

export function rampChar(t: number, ramp: string): string {
	if (t < 0) t = 0;
	else if (t > 1) t = 1;
	const n = ramp.length;
	const i = t === 1 ? n - 1 : (t * n) | 0;
	return ramp[i];
}

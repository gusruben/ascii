<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';
	import { getBilinearWeights } from '$lib/ascii/glyphShape';
	import { buildWideAtlas, matchWide, WMASK_WORDS, WGAREA, WGW } from '$lib/ascii/wideAtlas';
	import { TEXTURE_LUMA, TEX_W, TEX_H } from './textureLuma';

	// Same shader chain as /sunlight (1:1 port of microsoft.ai's hero
	// `<block-gl>`: vignette → sine warp → shatter → bokeh → texture
	// composite), but the per-cell glyph match runs against the wide-atlas
	// matcher (~1500 unique Unicode shapes after dedupe + monospace-advance
	// gate) instead of the 95-glyph ASCII matcher.
	//
	// What the swap actually changes:
	//   - For Bayer-dithered partial-fill cells (most of the canvas), the
	//     matcher now has block elements, eighths, geometric shapes, math
	//     operators, and Braille dot patterns to choose from. Borderline
	//     densities resolve to richer half-cell / partial-fill glyphs
	//     instead of the ASCII alphabet's coarser approximations.
	//   - Solid-fill cells (`0xffffffff` target) match `█` directly via
	//     the wide atlas, where the ASCII atlas had to fall back to '#'.
	//   - Empty cells take the explicit space short-circuit unchanged.
	//
	// Everything inside the shader chain is verbatim from /sunlight; the
	// final pass is the only place that differs.

	// ── Original config (defaults.js) ──────────────────────────────────
	const SINE_FREQUENCY = 0.35;
	const SINE_AMPLITUDE = 0.0;
	const SINE_ROTATION = 0.0;
	const SHATTER_AMOUNT_SCALE = 0.534;
	const SHATTER_SPREAD = 1.0;
	const SHATTER_ANGLE_DEG = 44;
	const SHATTER_SKEW = 0.84;
	const VIGNETTE_RADIUS = 0.354;
	const VIGNETTE_FALLOFF = 1.0;
	const VIGNETTE_SKEW = 0.54;
	const VIGNETTE_ANGLE = 0.0;
	const POINTER_LERP = 0.1;

	const PI3 = 1.04709283144;
	const TWO_PI = 6.28318530718;
	const SINE_FREQ_K = 20 * SINE_FREQUENCY;
	const SINE_AMP = SINE_AMPLITUDE * 0.2;
	const SHATTER_ANGLE_RAD = -(SHATTER_ANGLE_DEG / 360) * 2 * Math.PI;
	const SHATTER_COS = Math.cos(SHATTER_ANGLE_RAD);
	const SHATTER_SIN = Math.sin(SHATTER_ANGLE_RAD);
	const SHATTER_SKEW_X = 1;
	const SHATTER_SKEW_Y = 1 - SHATTER_SKEW;
	const ST_MUL = 50 * SHATTER_AMOUNT_SCALE;
	const VIG_HALF_R = VIGNETTE_RADIUS * 0.5;
	const VIG_INNER = VIG_HALF_R - VIGNETTE_FALLOFF * VIG_HALF_R * 0.5;
	const VIG_OUTER = VIG_HALF_R + VIGNETTE_FALLOFF * VIG_HALF_R * 0.5;
	const VIG_SKEW_X = VIGNETTE_SKEW;
	const VIG_SKEW_Y = 1 - VIGNETTE_SKEW;
	const VIG_ANGLE_RAD = VIGNETTE_ANGLE * TWO_PI;
	const VIG_COS = Math.cos(VIG_ANGLE_RAD);
	const VIG_SIN = Math.sin(VIG_ANGLE_RAD);

	const GOLDEN_ANGLE = 2.39996323;
	const BOKEH_ITER = 50;
	const bokehOffsets = new Float32Array(BOKEH_ITER * 2);
	{
		let r = 1;
		for (let i = 0; i < BOKEH_ITER; i++) {
			const theta = i * GOLDEN_ANGLE;
			r += 1 / r;
			bokehOffsets[i * 2] = (r - 1) * Math.cos(theta);
			bokehOffsets[i * 2 + 1] = (r - 1) * Math.sin(theta);
		}
	}

	const BG_COLOR_LUMA = 0.299 * 1.0 + 0.587 * (170 / 255) + 0.114 * (165 / 255);
	const OVERLAY_A = 2 * BG_COLOR_LUMA - 1;
	const OVERLAY_B = 2 * (1 - BG_COLOR_LUMA);
	const BASE_A = BG_COLOR_LUMA * 0.39 + OVERLAY_A * 0.61;
	const BASE_B = OVERLAY_B * 0.61;

	function sampleTexture(u: number, v: number): number {
		let uu = u - Math.floor(u);
		let vv = v - Math.floor(v);
		const fx = uu * (TEX_W - 1);
		const fy = vv * (TEX_H - 1);
		const ix = fx | 0;
		const iy = fy | 0;
		const tx = fx - ix;
		const ty = fy - iy;
		const ix1 = ix + 1 < TEX_W ? ix + 1 : ix;
		const iy1 = iy + 1 < TEX_H ? iy + 1 : iy;
		const a = TEXTURE_LUMA[iy * TEX_W + ix];
		const b = TEXTURE_LUMA[iy * TEX_W + ix1];
		const c2 = TEXTURE_LUMA[iy1 * TEX_W + ix];
		const d = TEXTURE_LUMA[iy1 * TEX_W + ix1];
		const ab = a + (b - a) * tx;
		const cd = c2 + (d - c2) * tx;
		return (ab + (cd - ab) * ty) / 255;
	}

	let field = new Float32Array(0);
	let bokehBuf = new Float32Array(0);
	let outputBuf = new Float32Array(0);
	let cornerW = 0;
	let cornerH = 0;
	let cursorU = 0.5;
	let cursorV = 0.5;

	const _hash: [number, number] = [0, 0];

	function smoothstep(e0: number, e1: number, x: number): number {
		let t = (x - e0) / (e1 - e0);
		if (t < 0) t = 0;
		else if (t > 1) t = 1;
		return t * t * (3 - 2 * t);
	}

	function random2(px: number, py: number, out: [number, number]) {
		const a = Math.sin(px * 127.1 + py * 311.7) * 43758.5453;
		const b = Math.sin(px * 269.5 + py * 183.3) * 43758.5453;
		out[0] = a - Math.floor(a);
		out[1] = b - Math.floor(b);
	}

	function sample(
		u: number,
		v: number,
		t: number,
		aspect: number,
		posX: number,
		posY: number
	): number {
		const wcx0 = u * 2 - 1;
		const wcy0 = v * 2 - 1;
		const time = t * 0.25;
		const phase = time * PI3;
		const waveX = Math.sin((wcy0 + 0.5) * SINE_FREQ_K + phase) * SINE_AMP;
		const waveY = Math.sin((wcx0 - 0.5) * SINE_FREQ_K + phase) * SINE_AMP;
		const wcx1 = wcx0 + (waveX * (1 - SINE_ROTATION) + 0 * SINE_ROTATION);
		const wcy1 = wcy0 + (0 * (1 - SINE_ROTATION) + waveY * SINE_ROTATION);
		let su = wcx1 * 0.5 + 0.5;
		let sv = wcy1 * 0.5 + 0.5;

		const stx0 = (su - 0.5) * aspect * ST_MUL;
		const sty0 = (sv - 0.5) * ST_MUL;
		const stxR = stx0 * SHATTER_COS - sty0 * SHATTER_SIN;
		const styR = stx0 * SHATTER_SIN + sty0 * SHATTER_COS;
		const stx = stxR * SHATTER_SKEW_X;
		const sty = styR * SHATTER_SKEW_Y;
		const ix = Math.floor(stx);
		const iy = Math.floor(sty);
		const fxA = stx - ix;
		const fyA = sty - iy;
		let mDist = 15;
		let mPx = 0;
		let mPy = 0;
		const tw = 5 + t * 0.2;
		for (let nj = -1; nj <= 1; nj++) {
			for (let ni = -1; ni <= 1; ni++) {
				random2(ix + ni, iy + nj, _hash);
				const px = 0.5 + 0.5 * Math.sin(tw + TWO_PI * _hash[0]);
				const py = 0.5 + 0.5 * Math.sin(tw + TWO_PI * _hash[1]);
				const dx = ni + px - fxA;
				const dy = nj + py - fyA;
				const d = Math.sqrt(dx * dx + dy * dy);
				if (d < mDist) {
					mDist = d;
					mPx = px;
					mPy = py;
				}
			}
		}
		const offX = mPx * 0.2 * SHATTER_SPREAD * 2 - SHATTER_SPREAD * 0.2;
		const offY = mPy * 0.2 * SHATTER_SPREAD * 2 - SHATTER_SPREAD * 0.2;
		su += offX;
		sv += offY;

		const uvA_x = su * aspect;
		const uvA_y = sv;
		const uvR_x = uvA_x * VIG_COS - uvA_y * VIG_SIN;
		const uvR_y = uvA_x * VIG_SIN + uvA_y * VIG_COS;
		const uvF_x = uvR_x * VIG_SKEW_X;
		const uvF_y = uvR_y * VIG_SKEW_Y;
		const posA_x = posX * aspect;
		const posA_y = posY;
		const posR_x = posA_x * VIG_COS - posA_y * VIG_SIN;
		const posR_y = posA_x * VIG_SIN + posA_y * VIG_COS;
		const posF_x = posR_x * VIG_SKEW_X;
		const posF_y = posR_y * VIG_SKEW_Y;
		const ddx = uvF_x - posF_x;
		const ddy = uvF_y - posF_y;
		const radius = Math.sqrt(ddx * ddx + ddy * ddy);
		const falloff = smoothstep(VIG_INNER, VIG_OUTER, radius);
		return 1 - falloff;
	}

	function sampleField(u: number, v: number, W: number, H: number, cW: number): number {
		const fx = u * W;
		const fy = v * H;
		let ix = fx | 0;
		let iy = fy | 0;
		let tx = fx - ix;
		let ty = fy - iy;
		if (ix < 0) {
			ix = 0;
			tx = 0;
		} else if (ix > W - 1) {
			ix = W - 1;
			tx = 1;
		}
		if (iy < 0) {
			iy = 0;
			ty = 0;
		} else if (iy > H - 1) {
			iy = H - 1;
			ty = 1;
		}
		const i00 = iy * cW + ix;
		const a = field[i00];
		const b = field[i00 + 1];
		const c2 = field[i00 + cW];
		const d = field[i00 + cW + 1];
		const ab = a + (b - a) * tx;
		const cd = c2 + (d - c2) * tx;
		return ab + (cd - ab) * ty;
	}

	function bokeh(
		u: number,
		v: number,
		aspect: number,
		W: number,
		H: number,
		cW: number
	): number {
		const PIXEL = 0.04 * 0.075;
		const PXX = PIXEL / aspect;
		const PXY = PIXEL;
		const noiseOffset = (fract(Math.sin(u * 12.9898 + v * 78.233) * 43758.5453) - 0.5) * 0.01;
		let acc = 0;
		let weight = 0;
		for (let i = 0; i < BOKEH_ITER; i++) {
			const theta = i * GOLDEN_ANGLE;
			const ox0 = bokehOffsets[i * 2] * PXX;
			const oy0 = bokehOffsets[i * 2 + 1] * PXY;
			const jitterAmount = 0.05 * (Math.sin(theta * 0.1) * 0.5 + 0.5);
			const jitterMul = 1 + jitterAmount * Math.sin(theta * 0.7 + noiseOffset);
			const ox = ox0 * jitterMul;
			const oy = oy0 * jitterMul;
			const c = sampleField(u + ox, v + oy, W, H, cW);
			const cl = c < 0 ? 0 : c > 1 ? 1 : c;
			const c9 = cl * cl * cl * cl * cl * cl * cl * cl * cl;
			const w = 5 + c9 * 150;
			acc += cl * w;
			weight += w;
		}
		return acc / weight;
	}

	function fract(x: number): number {
		return x - Math.floor(x);
	}

	const target = new Uint32Array(WMASK_WORDS);
	let atlasReady = false;

	function draw(c: AsciiApi) {
		if (!atlasReady) {
			buildWideAtlas();
			atlasReady = true;
		}

		const W = c.cols;
		const H = c.rows;
		const cW = W + 1;
		const cH = H + 1;
		if (cW !== cornerW || cH !== cornerH) {
			cornerW = cW;
			cornerH = cH;
			field = new Float32Array(cW * cH);
			bokehBuf = new Float32Array(cW * cH);
			outputBuf = new Float32Array(cW * cH);
		}

		const t = c.elapsed;
		const aspect = W / (H * c.cellAspect);

		const mu = c.mouse.fx / W;
		const mv = c.mouse.fy / H;
		if (c.mouse.fx >= 0 && c.mouse.fy >= 0) {
			cursorU += (mu - cursorU) * POINTER_LERP;
			cursorV += (mv - cursorV) * POINTER_LERP;
		}

		const invW = 1 / W;
		const invH = 1 / H;
		for (let j = 0; j < cH; j++) {
			const v = j * invH;
			const rowOff = j * cW;
			for (let i = 0; i < cW; i++) {
				const u = i * invW;
				field[rowOff + i] = sample(u, v, t, aspect, cursorU, cursorV);
			}
		}

		for (let j = 0; j < cH; j++) {
			const v = j * invH;
			const rowOff = j * cW;
			for (let i = 0; i < cW; i++) {
				const u = i * invW;
				bokehBuf[rowOff + i] = bokeh(u, v, aspect, W, H, cW);
			}
		}

		for (let j = 0; j < cH; j++) {
			const v = j * invH;
			const rowOff = j * cW;
			for (let i = 0; i < cW; i++) {
				const u = i * invW;
				const tex = sampleTexture(u, v);
				const base = BASE_A + BASE_B * tex;
				outputBuf[rowOff + i] = base * (0.74 + 0.26 * bokehBuf[rowOff + i]);
			}
		}

		const LUMA_MIN = 0.561;
		const LUMA_MAX = 0.862;
		const INV_LUMA_RANGE = 1 / (LUMA_MAX - LUMA_MIN);
		const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

		const atlas = buildWideAtlas();
		const wts = getBilinearWeights();
		const codes = atlas.codes;

		for (let y = 0; y < H; y++) {
			const r0 = y * cW;
			const r1 = (y + 1) * cW;
			for (let x = 0; x < W; x++) {
				const tl = (outputBuf[r0 + x] - LUMA_MIN) * INV_LUMA_RANGE;
				const tr = (outputBuf[r0 + x + 1] - LUMA_MIN) * INV_LUMA_RANGE;
				const bl = (outputBuf[r1 + x] - LUMA_MIN) * INV_LUMA_RANGE;
				const br = (outputBuf[r1 + x + 1] - LUMA_MIN) * INV_LUMA_RANGE;

				if (tl < 0.03 && tr < 0.03 && bl < 0.03 && br < 0.03) {
					c.setI(x, y, 32, 0, 1);
					continue;
				}
				if (tl > 0.97 && tr > 0.97 && bl > 0.97 && br > 0.97) {
					target[0] = 0xffffffff;
					target[1] = 0xffffffff;
					target[2] = 0xffffffff;
					target[3] = 0xffffffff;
				} else {
					target[0] = 0;
					target[1] = 0;
					target[2] = 0;
					target[3] = 0;
					for (let i = 0; i < WGAREA; i++) {
						const off = i << 2;
						const v =
							tl * wts[off] + tr * wts[off + 1] + bl * wts[off + 2] + br * wts[off + 3];
						const sx = i & (WGW - 1);
						const sy = (i / WGW) | 0;
						const bayer = (BAYER4[(sy & 3) * 4 + (sx & 3)] + 0.5) * (1 / 16);
						if (v > bayer) target[i >>> 5] |= 1 << (i & 31);
					}
				}

				const idx = matchWide(target[0], target[1], target[2], target[3], atlas);
				c.setI(x, y, codes[idx], 0, 1);
			}
		}
	}
</script>

<AsciiCanvas effect={draw} selectable={false} />

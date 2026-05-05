<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';
	import {
		GAREA,
		GW,
		MASK_WORDS,
		getBilinearWeights,
		getGlyphAtlas,
		matchMask,
		type Mask
	} from '$lib/ascii/glyphShape';
	import { TEXTURE_LUMA, TEX_W, TEX_H } from './textureLuma';

	// 1:1 port of the microsoft.ai hero `<block-gl>` shader chain.
	//
	// The original is a chain of fragment-shader passes ping-ponging
	// between two render targets. Each pass takes `tInput` (the previous
	// pass's output) and writes to a target:
	//
	//   1. vignetteMaterial   radial smoothstep, mouse-following spotlight
	//   2. sineMaterial       sin-warps UVs of the vignette
	//   3. shatterMaterial    Voronoi-cell offsets the warped UVs
	//   4. bokehMaterialFast  50-tap golden-angle blur
	//   5. outputMaterial     composites the bokeh result with a STATIC
	//                         painterly texture (orange-gradient.png) and
	//                         a peach background color
	//
	// The eye locks onto the painterly OVALS that drift around the page —
	// those are baked into the static texture (see textureLuma.ts). The
	// vignette → bokeh chain only modulates the texture at ~26% blend, so
	// it acts as a soft animated "highlight pass" on top of an otherwise
	// fixed pattern. Without that texture the contour reduces to a single
	// wobbly oval that follows the cursor; with it, the multiple ovals the
	// user actually sees come through.
	//
	// Every numeric constant below comes from /tmp/msai-hero/defaults.js
	// (the bundled `Un` config object), captured verbatim from the site.
	//
	// For the binary contour we collapse RGBA to LUMA at every pass —
	// vignette outputs `mix(clearColor, vignetteColor, falloff)` so its
	// luma is `1 - 0.654·falloff` ≈ 1 in the spotlight, ≈ 0.14 outside.
	// We carry just the bright-fraction `(1 - falloff)` through the chain
	// since the contour only cares about whether a corner is "above
	// threshold" after compositing.
	//
	// THE ONLY MOUSE-DRIVEN UNIFORM IS `vignetteMaterial.uPos = currPointer`
	// (verified at block-gl-element.js:328). The other passes pin uPos at
	// (0.5, 0.5) and have uTrackMouse = 0 (defaults.js: sine.trackMouse=0,
	// shatter has no mousePos at all, bokeh.trackMouse=0). So the cursor
	// drives only where the vignette's bright opening sits; sine + shatter
	// + bokeh all act around fixed screen center.
	//
	// Pointer smoothing is the shader's own:
	//   currPointer += (pointer - currPointer) * 0.1
	// per frame (block-gl-element.js:271).

	const shapeTarget: Mask = new Uint32Array(MASK_WORDS);

	// ── Original config (defaults.js) ──────────────────────────────────
	// Each constant here lines up with one entry of the `Un` object the
	// shaders read.
	const SINE_FREQUENCY = 0.35;
	// Original is 1.18 (= 0.236 in UV after `* 0.2`). At our cell resolution
	// every row gets shifted x by the same per-row sine, and the binary
	// threshold turns that smooth shift into a sharp "whole-shape warps
	// left/right" pattern. The live page hides this in soft color blending
	// — we can't, so the amplitude is zeroed. Frequency/structure stay
	// in place so the pass is still wired up; the rest of the chain
	// (shatter anchors orbiting at t·0.2) supplies the breathing.
	const SINE_AMPLITUDE = 0.0;
	const SINE_ROTATION = 0.0;
	const SHATTER_AMOUNT_SCALE = 0.534; // Un.shatter.scale (becomes uAmount)
	const SHATTER_SPREAD = 1.0; // Un.shatter.amount (becomes uSpread)
	const SHATTER_ANGLE_DEG = 44;
	const SHATTER_SKEW = 0.84;
	const VIGNETTE_RADIUS = 0.354;
	const VIGNETTE_FALLOFF = 1.0;
	const VIGNETTE_SKEW = 0.54;
	const VIGNETTE_ANGLE = 0.0; // turns
	const POINTER_LERP = 0.1;

	// ── Precomputed ────────────────────────────────────────────────────
	const PI3 = 1.04709283144; // matches `#define PI3` in sine shader
	const TWO_PI = 6.28318530718;
	const SINE_FREQ_K = 20 * SINE_FREQUENCY; // 7.0
	const SINE_AMP = SINE_AMPLITUDE * 0.2; // 0.236
	// Negated. The shader rotates +44° CCW in its y-up frame; we operate
	// in screen-y-down (v=0 at top of canvas), so the same rotation matrix
	// orients shatter cells along TL→BR instead of the BL→TR you see on
	// the live page. Negating the angle flips the visual direction back.
	const SHATTER_ANGLE_RAD = -(SHATTER_ANGLE_DEG / 360) * 2 * Math.PI;
	const SHATTER_COS = Math.cos(SHATTER_ANGLE_RAD);
	const SHATTER_SIN = Math.sin(SHATTER_ANGLE_RAD);
	// shatter shader: `skew = mix(vec2(1), vec2(1, 0), uSkew)` → (1, 1-uSkew)
	const SHATTER_SKEW_X = 1;
	const SHATTER_SKEW_Y = 1 - SHATTER_SKEW;
	const ST_MUL = 50 * SHATTER_AMOUNT_SCALE;
	const VIG_HALF_R = VIGNETTE_RADIUS * 0.5;
	const VIG_INNER = VIG_HALF_R - VIGNETTE_FALLOFF * VIG_HALF_R * 0.5;
	const VIG_OUTER = VIG_HALF_R + VIGNETTE_FALLOFF * VIG_HALF_R * 0.5;
	// vignette shader: `skew = vec2(uSkew, 1.0 - uSkew)`
	const VIG_SKEW_X = VIGNETTE_SKEW;
	const VIG_SKEW_Y = 1 - VIGNETTE_SKEW;
	const VIG_ANGLE_RAD = VIGNETTE_ANGLE * TWO_PI;
	const VIG_COS = Math.cos(VIG_ANGLE_RAD);
	const VIG_SIN = Math.sin(VIG_ANGLE_RAD);

	// ── Bokeh kernel (Vogel / golden-angle spiral) ─────────────────────
	// Shader builds offsets in a loop: r starts at 1, every iter does
	//   r += 1/r;  offset = (r-1) * vec2(cos(theta), sin(theta));
	// with theta stepping by GOLDEN_ANGLE. We precompute that into a
	// table since it doesn't depend on the pixel.
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

	// ── Output composition ─────────────────────────────────────────────
	// Verbatim from outputMaterial fragment shader. uBgColor = #FFAAA5,
	// uOutputColor = #FFD198. Both are converted to luma via the
	// standard ITU-R BT.601 weights `(0.299, 0.587, 0.114)` so the
	// composition can run on scalars instead of RGB tuples.
	const BG_COLOR_LUMA = 0.299 * 1.0 + 0.587 * (170 / 255) + 0.114 * (165 / 255); // ≈ 0.764
	// `overlay(base, blend)` for two scalars where `base = BG_COLOR_LUMA > 0.5`:
	//   overlay = 1 - 2·(1-base)·(1-blend)  =  (2·base - 1) + 2·(1-base)·blend
	// So the per-pass luma reduces to a linear function of bgTex.
	const OVERLAY_A = 2 * BG_COLOR_LUMA - 1; // ≈ 0.528
	const OVERLAY_B = 2 * (1 - BG_COLOR_LUMA); // ≈ 0.472
	// `base = mix(uBgColor, overlay(uBgColor, bgTex), 0.61)`
	const BASE_A = BG_COLOR_LUMA * 0.39 + OVERLAY_A * 0.61; // ≈ 0.620
	const BASE_B = OVERLAY_B * 0.61; // ≈ 0.288

	function sampleTexture(u: number, v: number): number {
		// Wrap UV — texture is loaded with REPEAT in the shader (initWebgl
		// at block-gl-element.js:231). We use modular wrap so panning past
		// an edge tiles the texture instead of clamping.
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

	// ── State ──────────────────────────────────────────────────────────
	let field = new Float32Array(0); // warped vignette (sine ∘ shatter)
	let bokehBuf = new Float32Array(0); // bokeh-blurred field
	let outputBuf = new Float32Array(0); // final composited luma
	let cornerW = 0;
	let cornerH = 0;
	// Smoothed pointer, in UV [0,1]². Matches the shader's `currPointer`.
	let cursorU = 0.5;
	let cursorV = 0.5;

	const _hash: [number, number] = [0, 0];

	function smoothstep(e0: number, e1: number, x: number): number {
		let t = (x - e0) / (e1 - e0);
		if (t < 0) t = 0;
		else if (t > 1) t = 1;
		return t * t * (3 - 2 * t);
	}

	// GLSL `random2(p) = fract(sin(p · K) * 43758.5453)` — written into
	// `out` to avoid allocating a [px, py] tuple inside the inner loop.
	function random2(px: number, py: number, out: [number, number]) {
		const a = Math.sin(px * 127.1 + py * 311.7) * 43758.5453;
		const b = Math.sin(px * 269.5 + py * 183.3) * 43758.5453;
		out[0] = a - Math.floor(a);
		out[1] = b - Math.floor(b);
	}

	// ── Pass chain composed as a single function ───────────────────────
	// Returns the vignette luma (1 in the bright peach zone, 0 in the
	// dark plum surround) sampled through the sine + shatter UV warps.
	// `posX`/`posY` is the vignette's position uniform — the only place
	// the cursor enters the math.
	function sample(u: number, v: number, t: number, aspect: number, posX: number, posY: number): number {
		// ── sineMaterial ──
		// waveCoord = vUv * 2 - 1
		// time = uTime * 0.25
		// frequency = 20 * uFrequency  (= 7)
		// amp = uAmplitude * 0.2  (= 0.236)
		// waveX = sin((wc.y + uPos.y) * freq + time * PI3) * amp     (uPos = (0.5, 0.5))
		// waveY = sin((wc.x - uPos.x) * freq + time * PI3) * amp
		// wc += vec2(mix(waveX, 0, uRotation), mix(0, waveY, uRotation))
		//   uRotation = 0  →  wc.x += waveX,  wc.y unchanged
		// finalUV = wc * 0.5 + 0.5
		const wcx0 = u * 2 - 1;
		const wcy0 = v * 2 - 1;
		const time = t * 0.25;
		const phase = time * PI3;
		const waveX = Math.sin((wcy0 + 0.5) * SINE_FREQ_K + phase) * SINE_AMP;
		const waveY = Math.sin((wcx0 - 0.5) * SINE_FREQ_K + phase) * SINE_AMP;
		const wcx1 = wcx0 + (waveX * (1 - SINE_ROTATION) + 0 * SINE_ROTATION);
		const wcy1 = wcy0 + (0 * (1 - SINE_ROTATION) + waveY * SINE_ROTATION);
		// dist = 1 (mixRadius=1, trackMouse=0) → uv = finalUV
		let su = wcx1 * 0.5 + 0.5;
		let sv = wcy1 * 0.5 + 0.5;

		// ── shatterMaterial ──
		// st = (uv - uPos) * vec2(aspect, 1) * 50 * uAmount         (uPos = (0.5, 0.5))
		// st = st * rot(uAngle * 2π) * skew                          (skew = (1, 1-uSkew))
		// 3×3 search:
		//   point = random2(i_st + neighbor)
		//   point = 0.5 + 0.5 * sin(5 + uTime*0.2 + 2π*point)
		//   diff  = neighbor + point - f_st
		//   if (length(diff) < m_dist) m_point = point;
		// offset = m_point * 0.2 * uSpread * 2 - uSpread * 0.2
		// uv += offset * dist                                         (dist = 1)
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

		// ── vignetteMaterial ──
		// scaledUV  = uv  * vec2(aspect, 1) * rot(uAngle*2π) * skew
		// scaledPos = pos * vec2(aspect, 1) * rot(uAngle*2π) * skew  (pos = currPointer)
		// radius   = distance(scaledUV, scaledPos)
		// halfR    = uRadius * 0.5
		// inner    = halfR - uFalloff * halfR * 0.5
		// outer    = halfR + uFalloff * halfR * 0.5
		// falloff  = smoothstep(inner, outer, radius)   (uDisplace = 0 → no shift)
		// fragColor = mix(clear, vignetteColor, falloff)   ← luma: 1-falloff
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

	// Bilinear sample of the `field` corner buffer at UV (clamped at edges).
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

	// ── bokehMaterialFast ──
	// pixelSize = vec2(1/aspect, 1) * 0.04 * 0.075         (≈ (0.0018/aspect, 0.003))
	// Per-iteration:
	//   r += 1/r;  off = (r-1) * (cos(theta), sin(theta)) * pixelSize
	//   jitterAmount = 0.05 * (sin(theta*0.1) * 0.5 + 0.5)
	//   off *= 1 + jitterAmount * sin(theta*0.7 + noiseOffset)
	//   sampleOff = rotationMatrix * off                   (per-pixel small rotation)
	//   c = texture(tInput, uv + sampleOff)
	//   w = 5 + pow(c, 9) * 150
	//   accColor += c * w;  accWeight += w
	//
	// Per-pixel noise rotation is ±~1° (negligible vs the kernel scale)
	// and exists just to break up Vogel-spiral aliasing — for a binary
	// contour it's invisible. We keep the jitter modulation, drop the
	// rotation, and use a deterministic per-pixel hash in place of the
	// blue-noise texture lookup.
	function bokeh(u: number, v: number, aspect: number, W: number, H: number, cW: number): number {
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

	function draw(c: AsciiApi) {
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
		// shader: aspectRatio = uResolution.x / uResolution.y. In our
		// monospace cell grid, pixel-space dimensions are (W·cellW, H·cellH)
		// where cellAspect = cellH / cellW, so aspect = W / (H · cellAspect).
		const aspect = W / (H * c.cellAspect);

		// ── shader: currPointer += (pointer - currPointer) * 0.1 ──
		// `c.mouse.fx`, `c.mouse.fy` are in cell coords; we lerp toward
		// the cursor's UV. Pointer outside canvas just keeps pulling
		// toward last-seen position, same as block-gl ignores mousemoves
		// outside the document.
		const mu = c.mouse.fx / W;
		const mv = c.mouse.fy / H;
		// `c.mouse.fx` reads -1 before any movement; ignore that.
		if (c.mouse.fx >= 0 && c.mouse.fy >= 0) {
			cursorU += (mu - cursorU) * POINTER_LERP;
			cursorV += (mv - cursorV) * POINTER_LERP;
		}

		// ── Pass 1: vignette ∘ sineWarp ∘ shatter, evaluated at corners ──
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

		// ── Pass 2: bokeh ──
		for (let j = 0; j < cH; j++) {
			const v = j * invH;
			const rowOff = j * cW;
			for (let i = 0; i < cW; i++) {
				const u = i * invW;
				bokehBuf[rowOff + i] = bokeh(u, v, aspect, W, H, cW);
			}
		}

		// ── Pass 3: outputMaterial composition ─────────────────────────
		// Verbatim from outputMaterial fragment shader collapsed to luma:
		//   base  = mix(uBgColor, overlay(uBgColor, bgTex), 0.61)
		//   final = base * mix(1, bokeh, 0.26)
		//         = base · (0.74 + 0.26·bokeh)
		// bgTex is sampled at *unwrapped* vUv, NOT the warped UVs — only
		// the bokeh chain sees the warps. That's what makes the texture's
		// painterly oval pattern stay anchored to the screen while the
		// bokeh modulation drifts and tracks the cursor.
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

		// ── Bayer-dithered shading instead of binary contour ──
		// A single threshold gives us only `#` (full) and `space` (empty)
		// for interior cells, with shading glyphs confined to a thin band
		// at the threshold boundary. To put the matcher's full ASCII
		// repertoire (`. , : ; ' " * + = o etc.`) to work everywhere,
		// we instead dither each sub-cell against a Bayer threshold
		// pattern: a cell at normalized luma 0.3 gets ~30% of its
		// sub-cells inked in a stable cross-hatch, and the matcher picks
		// whichever glyph has ink in roughly those positions.
		//
		// `LUMA_MIN`/`LUMA_MAX` are the min/max final-luma values we
		// expect across the canvas — derived analytically from
		// base ∈ [0.758, 0.862] (bgTex luma in [0.48, 0.84]) and
		// final = base · (0.74 + 0.26·bokeh) with bokeh ∈ [0, 1].
		const LUMA_MIN = 0.561;
		const LUMA_MAX = 0.862;
		const INV_LUMA_RANGE = 1 / (LUMA_MAX - LUMA_MIN);

		// 4×4 Bayer matrix tiled across the 8×16 sub-cell grid (`(sy & 3) * 4
		// + (sx & 3)`). Threshold = `(value + 0.5) / 16` puts the 16 levels
		// at 0.03, 0.09, …, 0.97 — even spacing, no value at exactly 0 or
		// 1 so the extremes of luma still produce all-empty / all-full.
		const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

		const atlas = getGlyphAtlas();
		const wts = getBilinearWeights();
		const target = shapeTarget;

		for (let y = 0; y < H; y++) {
			const r0 = y * cW;
			const r1 = (y + 1) * cW;
			for (let x = 0; x < W; x++) {
				// Normalized luma per corner — 0 at LUMA_MIN (canvas's
				// darkest possible cell), 1 at LUMA_MAX. Below 0 / above 1
				// are clamped because the analytical bounds aren't always
				// hit exactly (bokeh can fall short of [0, 1] in practice).
				const tl = (outputBuf[r0 + x] - LUMA_MIN) * INV_LUMA_RANGE;
				const tr = (outputBuf[r0 + x + 1] - LUMA_MIN) * INV_LUMA_RANGE;
				const bl = (outputBuf[r1 + x] - LUMA_MIN) * INV_LUMA_RANGE;
				const br = (outputBuf[r1 + x + 1] - LUMA_MIN) * INV_LUMA_RANGE;

				// Quick-out: every corner below the smallest Bayer threshold
				// (0.03) → no sub-cell can be inked → emit space directly.
				if (tl < 0.03 && tr < 0.03 && bl < 0.03 && br < 0.03) {
					c.setI(x, y, 32, 0, 1);
					continue;
				}
				// Quick-out: every corner above the largest Bayer threshold
				// (0.97) → all sub-cells inked → solid fill.
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
					for (let i = 0; i < GAREA; i++) {
						const off = i << 2;
						// Bilinear-interp the normalized luma to this sub-cell
						const v =
							tl * wts[off] +
							tr * wts[off + 1] +
							bl * wts[off + 2] +
							br * wts[off + 3];
						// Bayer threshold at this sub-cell position. The
						// 4×4 matrix tiles across the 8×16 sub-cell grid;
						// `(value + 0.5)/16` puts thresholds on (0, 1).
						const sx = i & (GW - 1);
						const sy = (i / GW) | 0;
						const bayer = (BAYER4[(sy & 3) * 4 + (sx & 3)] + 0.5) * (1 / 16);
						if (v > bayer) target[i >>> 5] |= 1 << (i & 31);
					}
				}

				const idx = matchMask(target);
				c.setI(x, y, atlas.codes[idx], 0, 1);
			}
		}
	}
</script>

<AsciiCanvas effect={draw} selectable={false} />

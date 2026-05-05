<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	// Ink & paper. The mouse is a calligraphy brush. Pigment is deposited
	// along the stroke and then physically diffuses outward through a
	// 5-point Laplacian (Stam-style explicit Euler), slowly evaporating.
	// Slow strokes drop heavy wet ink; quick flicks dry-brush across the
	// page. Holding the button down splatters a fat blob.
	//
	// Render is two co-existing traces:
	//   • Density ramp via `fieldArr` for the diffused pigment wash —
	//     default fg/bg keeps every row on the renderer's text fast path
	//     even though every cell varies char-by-char.
	//   • A short calligraphic "spine" of `-/|\` glyphs picked by the
	//     velocity angle at deposit time, which fades into the wash as
	//     the ink spreads.
	//
	// Pigment density is a scalar Float32 field; nothing varies per-cell
	// color, so the whole effect stays on the fastest path the runtime
	// has. Animated colors are absent on purpose — character density
	// already encodes intensity.

	const RAMP = ' \u00b7\u2219.,:;-=+*#%\u2588';

	let bufW = 0;
	let bufH = 0;
	let pigment = new Float32Array(0);
	let scratch = new Float32Array(0);

	type Stroke = { x: number; y: number; ang: number; t0: number };
	const STROKE_LEN = 256;
	const strokes: Stroke[] = Array.from({ length: STROKE_LEN }, () => ({
		x: 0,
		y: 0,
		ang: 0,
		t0: -1
	}));
	let strokeIdx = 0;

	let pressed = false;
	let mouseSeen = false;
	let frames = 0;

	function onDown() {
		pressed = true;
	}
	function onUp() {
		pressed = false;
	}

	function ensureBuffers(W: number, H: number) {
		if (bufW !== W || bufH !== H) {
			bufW = W;
			bufH = H;
			pigment = new Float32Array(W * H);
			scratch = new Float32Array(W * H);
		}
	}

	// Gaussian-ish pigment stamp around (x, y). Aspect-corrected so brush
	// blobs read as visually circular rather than vertically squashed by
	// the ~2:1 cell aspect.
	function stamp(
		x: number,
		y: number,
		W: number,
		H: number,
		p: Float32Array,
		amount: number,
		radius: number,
		aspect: number
	) {
		const sigma2 = radius * radius * 0.5;
		const xr = Math.ceil(radius);
		const yr = Math.max(1, Math.ceil(radius / aspect));
		const cx = Math.round(x);
		const cy = Math.round(y);
		const yMin = Math.max(0, cy - yr);
		const yMax = Math.min(H - 1, cy + yr);
		const xMin = Math.max(0, cx - xr);
		const xMax = Math.min(W - 1, cx + xr);
		for (let yy = yMin; yy <= yMax; yy++) {
			const dyv = (yy - y) * aspect;
			const dy2 = dyv * dyv;
			const rowOff = yy * W;
			for (let xx = xMin; xx <= xMax; xx++) {
				const dxf = xx - x;
				const r2 = dxf * dxf + dy2;
				const k = Math.exp(-r2 / sigma2);
				const idx = rowOff + xx;
				const next = p[idx] + amount * k;
				p[idx] = next > 2 ? 2 : next;
			}
		}
	}

	// Explicit-Euler 5-point Laplacian. rate ≤ 0.25 for stability.
	function diffuse(src: Float32Array, dst: Float32Array, W: number, H: number, rate: number) {
		const lastY = H - 1;
		const lastX = W - 1;
		for (let y = 0; y < H; y++) {
			const yp = y > 0 ? y - 1 : 0;
			const yn = y < lastY ? y + 1 : lastY;
			const r0 = y * W;
			const rp = yp * W;
			const rn = yn * W;
			{
				const c = src[r0];
				const u = src[rp];
				const d = src[rn];
				const rr = lastX > 0 ? src[r0 + 1] : c;
				dst[r0] = c + rate * (u + d + c + rr - 4 * c);
			}
			for (let x = 1; x < lastX; x++) {
				const c = src[r0 + x];
				const u = src[rp + x];
				const d = src[rn + x];
				const l = src[r0 + x - 1];
				const rr = src[r0 + x + 1];
				dst[r0 + x] = c + rate * (u + d + l + rr - 4 * c);
			}
			if (lastX > 0) {
				const c = src[r0 + lastX];
				const u = src[rp + lastX];
				const d = src[rn + lastX];
				const l = src[r0 + lastX - 1];
				dst[r0 + lastX] = c + rate * (u + d + l + c - 4 * c);
			}
		}
	}

	const DIR_CHARS = ['-', '/', '|', '\\'];
	function angleToDir(ang: number): string {
		// Bin angle to one of 4 directions, mod π (no orientation diff for
		// opposite arrows — '/' is the same stroke whether ↗ or ↙).
		let a = ang;
		if (a < 0) a += Math.PI;
		const bin = Math.round(a / (Math.PI / 4)) & 3;
		return DIR_CHARS[bin];
	}

	function effect(c: AsciiApi) {
		const W = c.cols;
		const H = c.rows;
		const aspect = c.cellAspect;
		ensureBuffers(W, H);

		if (c.mouse.x !== 0 || c.mouse.y !== 0) mouseSeen = true;

		// Self-demo: a Lissajous figure-8 path so the iframe preview shows
		// the effect breathing without user input.
		let mx: number, my: number, pmx: number, pmy: number;
		if (mouseSeen) {
			mx = c.mouse.fx;
			my = c.mouse.fy;
			pmx = c.mouse.px;
			pmy = c.mouse.py;
		} else {
			const z = frames / 55;
			mx = W * 0.5 + Math.sin(z) * W * 0.34;
			my = H * 0.5 + Math.sin(z * 2) * H * 0.34;
			const z2 = (frames - 1) / 55;
			pmx = W * 0.5 + Math.sin(z2) * W * 0.34;
			pmy = H * 0.5 + Math.sin(z2 * 2) * H * 0.34;
		}

		const dxv = mx - pmx;
		const dyv = (my - pmy) * aspect;
		const speed = Math.hypot(dxv, dyv);

		// Wet vs dry: slow strokes deposit more pigment, fast flicks less.
		// Step along the stroke so cursor jumps between frames don't leave
		// gaps in the line.
		const dist = Math.hypot(mx - pmx, my - pmy);
		const steps = Math.max(1, Math.ceil(dist * 1.4));
		const wet = Math.max(0.04, 0.55 / (1 + speed * 0.32));
		const radius = 1.8;
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			const sx = pmx + (mx - pmx) * t;
			const sy = pmy + (my - pmy) * t;
			if (sx >= 0 && sx < W && sy >= 0 && sy < H) {
				stamp(sx, sy, W, H, pigment, wet, radius, aspect);
			}
		}

		// Hold-to-splatter: while the button is down, sustain a fatter
		// deposit that bleeds heavily once diffusion takes over.
		if (pressed && mx >= 0 && mx < W && my >= 0 && my < H) {
			stamp(mx, my, W, H, pigment, 1.6, 3.6, aspect);
		}

		// Record the stroke for the directional overlay. Skip stationary
		// frames so a parked cursor doesn't pile up overlay glyphs.
		if (speed > 0.18 && mx >= 0 && mx < W && my >= 0 && my < H) {
			const ang = Math.atan2(dyv, dxv);
			const s = strokes[strokeIdx];
			s.x = mx;
			s.y = my;
			s.ang = ang;
			s.t0 = c.elapsed;
			strokeIdx = (strokeIdx + 1) % STROKE_LEN;
		}

		// Diffuse pigment, then apply slow evaporation in the same pass.
		diffuse(pigment, scratch, W, H, 0.13);
		const evap = 0.997;
		for (let i = 0; i < pigment.length; i++) pigment[i] = scratch[i] * evap;

		// Base wash — text fast path (default fg/bg, char-only variation).
		c.fieldArr(pigment, RAMP);

		// Directional spine. A few hundred cells max; default fg/bg means
		// each row stays on the text path even with these per-cell writes.
		const STROKE_LIFE = 0.65;
		const now = c.elapsed;
		for (let i = 0; i < STROKE_LEN; i++) {
			const s = strokes[i];
			if (s.t0 < 0) continue;
			const age = now - s.t0;
			if (age > STROKE_LIFE) {
				s.t0 = -1;
				continue;
			}
			const sx = s.x | 0;
			const sy = s.y | 0;
			if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
			c.set(sx, sy, angleToDir(s.ang));
		}

		c.text(0, 0, Math.round(c.fps) + ' FPS');
		frames++;
	}
</script>

<svelte:window onpointerdown={onDown} onpointerup={onUp} onpointercancel={onUp} />
<AsciiCanvas {effect} selectable={false} />
